/**
 * MarkLifecycleV2 — Svelte-native mark lifecycle with 2 effects + 1 flag.
 *
 * Replaces the 10-effect state machine in MarkLifecycle.svelte.ts by
 * eliminating DataClient, ViewManager, and the Mosaic callback protocol.
 * Uses QueryEngine for direct DuckDB queries and CrossfilterSelection
 * for reactive crossfilter predicates.
 *
 * Phase 1: Setup (one-shot async, one $effect)
 *   Batch all domain queries → register domains → mark scales ready
 *   → setupComplete = true
 *
 * Phase 2: Query (reactive, re-runs on filter change)
 *   filter ← $derived from CrossfilterSelection.predicate(markId)
 *   sql ← $derived from (table + select + caseExprs + filter)
 *   $effect: queryEngine.query(sql, { callerId: markId }) → arrowTable
 */

import { untrack } from 'svelte';
import type { Table } from '@uwdata/flechette';
import {
	Query,
	isNode,
	isAggregateExpression,
	sql,
	column as sqlColumn,
	cast,
	coalesce,
	isNotNull,
	and
} from '@uwdata/mosaic-sql';
import type { ExprValue } from '@uwdata/mosaic-sql';
import type { ScaleRequirement } from '$lib/scales/ScalePriorities';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { ArrowDataAccessor } from '$lib/data/DataAccessor';
import type { DataAccessor } from '$lib/data/DataAccessor';
import type {
	FieldRef,
	NormalizedSortConfig,
	Transform,
	ChartContext,
	ScaleStateInstance,
	ContinuousScaleState
} from '$lib/types';
import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import type { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { SizeScaleState } from '$lib/scales/SizeScaleState.svelte';
import type { QueryEngine } from '$lib/query-engine/QueryEngine';
import type { CrossfilterSelection, FilterExpr } from '$lib/query-engine/CrossfilterSelection.svelte';
import { isContinuousScale, isNumericScale } from '$lib/scales/scale-categories';
import { type AutoBinNode, isBinExpression } from '$lib/sql/bin';
import { type RollingAvgNode, isRollingAvgExpression } from '$lib/sql/rolling-avg';
import { isWindowExpression } from '$lib/sql/expression-utils';
import { generateMarkId, buildChannelFieldMap } from '../utils';
import { detectChannelsNeedingDataDomain } from './domain-computation';
import { buildQueryParts, assembleQuery, type QueryParts } from './query-builder';
import {
	setScalesReady,
	markDeferredScalesReady,
	registerDataDerivedDomains
} from './domain-registration';
import { fetchCategoricalDomains, fetchGlobalAggregates } from './domain-queries';

// ---------------------------------------------------------------------------
// Config (same shape as MarkLifecycleConfig — shared during transition)
// ---------------------------------------------------------------------------

export interface MarkLifecycleV2Config {
	markType: string;
	supportedScaleTypes: { x: string[]; y: string[] };
	scaleRequirements: {
		x: ScaleRequirement | null;
		y: ScaleRequirement | null;
	};
	inferredScaleColumns?: { x?: FieldRef; y?: FieldRef };
	table: string;
	transforms: Transform[];
	select: Record<string, unknown>;
	clientOptions?: { limit?: number; filterNulls?: unknown[] | null };
	sort?: NormalizedSortConfig;
	domain?: { x?: string[]; y?: string[] } | null;
	tooltip?: boolean | { sortTable?: boolean };
	constants?: Record<string, number>;
	colorChannel?: string;
	sizeChannel?: string;
	_orderConfig?: { seriesChannel: string | null; dimensionChannel: string };
	_filterNulls?: unknown[];
	fitDomain?: 'x' | 'y' | boolean;
	zeroBaseline?: { x?: boolean; y?: boolean };
	passiveScales?: boolean;
	tip?: (unknown | '*')[] | false;
	parallelMode?: boolean;
	parallelColumns?: string[];
}

// ---------------------------------------------------------------------------
// MarkLifecycleV2
// ---------------------------------------------------------------------------

export class MarkLifecycleV2 {
	// --- Public Reactive State ---
	setupComplete = $state(false);
	#arrowTable = $state<Table | null>(null);
	#dataVersion = $state(0);

	// --- Private Properties ---
	#config: MarkLifecycleV2Config;
	#queryEngine: QueryEngine;
	#chartContext: ChartContext;
	#markId: string;
	#selection: CrossfilterSelection | null;
	#scaleMap: Record<string, ScaleStateInstance | null> = {};
	#colorScaleState = $state<ColorScaleState | null>(null);
	#seriesScaleState = $state<ColorScaleState | null>(null);
	#sizeScaleState = $state<SizeScaleState | null>(null);

	// --- Transforms ---
	#transformCompiler: TransformCompiler;
	#autoBinNodes: Map<string, AutoBinNode> = new Map();
	#rollingAvgNodes: Map<string, RollingAvgNode> = new Map();

	// --- Query Cache ---
	#cachedQueryParts: QueryParts | null = null;
	#numericCastChannels: Set<string> | undefined;
	#queryPartsStale = false;

	// --- Domain State ---
	#channelsNeedingDataDomain: Set<string> = new Set();
	#dataDerivedDomainsSet = $state(false);
	#globalAggregatesSet = $state(false);
	#skipDomainUpdateForAxis: string | null = null;
	#lastBandDomainDataVersion: number | null = null;

	// --- Tooltip ---
	#tooltipTableName: string;
	#tooltipTableReady = $state(false);

	// --- Cleanup ---
	#destroyed = false;

	constructor(
		config: MarkLifecycleV2Config,
		queryEngine: QueryEngine,
		chartContext: ChartContext,
		markId: string,
		selection: CrossfilterSelection | null
	) {
		this.#config = config;
		this.#queryEngine = queryEngine;
		this.#chartContext = chartContext;
		this.#markId = markId;
		this.#selection = selection;

		// Tooltip table name
		this.#tooltipTableName = `_tt_${this.#markId.replace(/-/g, '_')}`;

		// Transform compiler
		this.#transformCompiler = new TransformCompiler(config.transforms || []);
		this.#detectAutoBins();

		// Detect channels needing data-derived domains
		this.#channelsNeedingDataDomain = detectChannelsNeedingDataDomain(
			config.select,
			config.scaleRequirements,
			this.#transformCompiler
		);

		// Register scale requirements with ChartContext (synchronous)
		this.#registerScaleRequirements();

		// Build scale map (synchronous — scales available from ChartContext)
		this.#scaleMap = {
			x: chartContext.xScaleState,
			y: chartContext.yScaleState
		};
		if (config.parallelMode) {
			const ps = chartContext.parallelScales;
			if (ps) {
				for (let i = 0; i < ps.columns.length; i++) {
					this.#scaleMap[ps.columns[i]] = ps.scaleStates[i];
				}
			}
		}

		// Start reactive effects
		this.#setupReactiveEffects();
	}

	// ===========================================================================
	// CONSTRUCTOR HELPERS
	// ===========================================================================

	#detectAutoBins(): void {
		for (const [channel, value] of Object.entries(this.#config.select)) {
			if (isBinExpression(value)) {
				this.#autoBinNodes.set(channel, value);
			} else if (isRollingAvgExpression(value)) {
				this.#rollingAvgNodes.set(channel, value);
				value.registerInvalidation(() => {
					this.#queryPartsStale = true;
					// TODO: trigger re-query via dataVersion bump
				});
			}
		}
	}

	#registerScaleRequirements(): void {
		const { scaleRequirements, inferredScaleColumns, table } = this.#config;
		const hasCatReducing = this.#transformCompiler.hasCategoryReducingTransforms();

		if (scaleRequirements?.x) {
			let config = scaleRequirements.x.config || {};
			if (scaleRequirements.x.type === 'band' && hasCatReducing) {
				const key = this.#transformCompiler.getCategoryTransformKey();
				if (key) config = { ...config, transformKey: `${table}:${key}` };
			}
			this.#chartContext.registerScaleType(
				'x',
				scaleRequirements.x.type,
				scaleRequirements.x.priority,
				this.#markId,
				config,
				inferredScaleColumns?.x
			);
		}

		if (scaleRequirements?.y) {
			let config = scaleRequirements.y.config || {};
			if (scaleRequirements.y.type === 'band' && hasCatReducing) {
				const key = this.#transformCompiler.getCategoryTransformKey();
				if (key) config = { ...config, transformKey: `${table}:${key}` };
			}
			this.#chartContext.registerScaleType(
				'y',
				scaleRequirements.y.type,
				scaleRequirements.y.priority,
				this.#markId,
				config,
				inferredScaleColumns?.y
			);
		}

		if (this.#config.parallelMode && this.#config.parallelColumns) {
			for (const col of this.#config.parallelColumns) {
				this.#chartContext.registerParallelColumn(col, this.#markId);
			}
		}
	}

	// ===========================================================================
	// REACTIVE EFFECTS (2 main + side concerns)
	// ===========================================================================

	#setupReactiveEffects(): void {
		// Phase 1: Setup (one-shot async)
		// Fetches all domains in parallel, registers them, marks scales ready.
		$effect(() => {
			if (this.setupComplete) return;

			// Wait for scale states to be available
			const { scaleTypes, xScaleState, yScaleState } = this.#chartContext;
			const scalesAvailable = this.#config.parallelMode
				? !!(scaleTypes && xScaleState)
				: !!(scaleTypes && xScaleState && yScaleState);
			if (!scalesAvailable) return;

			// Track color/series scale states for reactive re-entry
			const colorKey = this.#config.colorChannel || 'fill';
			const colorReady = !this.#config.select?.[colorKey] || !!this.#colorScaleState;

			untrack(() => {
				this.#runSetup(colorReady);
			});
		});

		// Phase 2: Query (reactive — re-runs on filter or SQL change)
		$effect(() => {
			if (!this.setupComplete) return;

			// Read filter from CrossfilterSelection (reactive via SvelteMap)
			const filter = this.#selection?.predicate(this.#markId) ?? [];

			// Read scale states that affect the query (CASE expressions, offsets)
			// Reading these inside the effect establishes reactive dependencies
			// so the query re-fires when domains change (band reorder, etc.)
			const xScaleState = this.#chartContext.xScaleState;
			const yScaleState = this.#chartContext.yScaleState;

			// Build the SQL (synchronous — uses cached query parts)
			const sqlStr = this.#buildQueryString(filter);
			if (!sqlStr) return;

			untrack(() => {
				this.#executeQuery(sqlStr);
			});
		});
	}

	// ===========================================================================
	// PHASE 1: SETUP
	// ===========================================================================

	async #runSetup(colorReady: boolean): Promise<void> {
		if (this.#destroyed) return;

		// Passive scales: skip domain fetching
		if (this.#config.passiveScales) {
			setScalesReady(
				this.#scaleMap,
				this.#channelsNeedingDataDomain,
				this.actualXScaleType,
				this.actualYScaleType,
				false,
				false
			);
			this.setupComplete = true;
			return;
		}

		try {
			const seriesKey = this.#config._orderConfig?.seriesChannel ?? null;

			// Batch all domain queries in parallel
			const [fetchCount, aggResult] = await Promise.all([
				fetchCategoricalDomains(
					this.#queryEngine as any, // TODO: adapt domain-queries.ts parameter type
					this.#config.table,
					this.#config.select,
					this.#config.sort,
					this.actualXScaleType,
					this.actualYScaleType,
					this.#chartContext.xScaleState as BandScaleState | null,
					this.#chartContext.yScaleState as BandScaleState | null,
					this.#chartContext.facetBandScale,
					this.#chartContext.fx,
					this.#config.colorChannel || 'fill',
					this.#colorScaleState,
					this.#config.sizeChannel || 'r',
					this.#sizeScaleState,
					this.#seriesScaleState,
					seriesKey,
					this.#transformCompiler.hasCategoryReducingTransforms(),
					this.#markId,
					this.#config.domain
				),
				fetchGlobalAggregates(
					this.#queryEngine as any, // TODO: adapt domain-queries.ts parameter type
					this.#config.table,
					this.#config.select,
					this.#channelsNeedingDataDomain,
					this.#autoBinNodes.size,
					this.#buildQueryForAggregates.bind(this),
					this.#config as any,
					this.#chartContext.xScaleState as ContinuousScaleState | null,
					this.#chartContext.yScaleState as ContinuousScaleState | null,
					this.#colorScaleState,
					this.#markId
				)
			]);

			if (this.#destroyed) return;

			if (aggResult.globalAggregatesSet) this.#globalAggregatesSet = true;

			// Mark scales ready
			setScalesReady(
				this.#scaleMap,
				this.#channelsNeedingDataDomain,
				this.actualXScaleType,
				this.actualYScaleType,
				this.#globalAggregatesSet,
				this.#dataDerivedDomainsSet
			);

			this.setupComplete = true;
		} catch (error) {
			if ((error as Error)?.name === 'AbortError') return;
			console.error(`[MarkLifecycleV2] Setup failed for ${this.#markId}:`, error);
		}
	}

	// ===========================================================================
	// PHASE 2: QUERY
	// ===========================================================================

	#buildQueryString(filter: FilterExpr[]): string | null {
		// Resolve query parts (cached unless stale)
		if (!this.#cachedQueryParts || this.#queryPartsStale) {
			this.#queryPartsStale = false;

			// Resolve autobins if present (needs fieldInfo — skip if unavailable)
			const resolvedSelect = { ...this.#config.select };
			// TODO: AutoBinNode.resolve() needs fieldInfo + scaleType.
			// For now, leave bin expressions unresolved — they'll be handled
			// when we migrate binned marks (RectMark). DotsMark has no bins.

			// Detect which channels need numeric cast for Float32 zero-copy
			this.#numericCastChannels = new Set<string>();
			for (const [ch, expr] of Object.entries(resolvedSelect)) {
				if (isNode(expr) && isAggregateExpression(expr as any)) {
					this.#numericCastChannels.add(ch);
				}
			}

			// Inline CASE expressions for band/color scales (replaces ViewManager)
			this.#inlineCaseExpressions(resolvedSelect);

			// Inline time offset expressions (replaces ViewManager time columns)
			this.#inlineTimeOffsets(resolvedSelect);

			this.#cachedQueryParts = buildQueryParts(
				resolvedSelect,
				this.#config._orderConfig ?? null,
				this.#transformCompiler.hasSQLTransforms()
			);
		}

		// Apply numeric CAST wrapping for zero-copy Float32 columns.
		// assembleQuery with forMosaic=false skips this, so we do it here.
		if (this.#numericCastChannels?.size) {
			for (const ch of this.#numericCastChannels) {
				const expr = this.#cachedQueryParts.selectDef[ch];
				if (expr != null) {
					this.#cachedQueryParts.selectDef[ch] = coalesce(
						cast(expr, 'REAL'),
						sql`'NaN'::REAL`
					);
				}
			}
			// Only apply once — clear to avoid double-wrapping on re-entry
			this.#numericCastChannels = undefined;
		}

		const q = assembleQuery(
			this.#config.table,
			this.#cachedQueryParts,
			filter as unknown[],
			this.#config._filterNulls ?? null,
			this.#transformCompiler,
			false, // forMosaic — always false in V2 (channel names throughout)
			undefined // numeric cast already applied above
		);

		// Apply LIMIT if configured
		if (this.#config.clientOptions?.limit) {
			q.limit(this.#config.clientOptions.limit);
		}

		return q?.toString() ?? null;
	}

	/**
	 * Inline CASE index expressions for band/point and ordinal color scales.
	 * Replaces ViewManager's view column with direct SQL in the SELECT.
	 */
	#inlineCaseExpressions(select: Record<string, unknown>): void {
		const skipBandIndex = this.#transformCompiler.hasCategoryReducingTransforms();

		// Band/point x scale
		if (
			!skipBandIndex &&
			(this.actualXScaleType === 'band' || this.actualXScaleType === 'point')
		) {
			const xScale = this.#chartContext.xScaleState as BandScaleState | null;
			if (xScale?.caseExpression) {
				select.x = sql`${xScale.caseExpression}`;
			}
		}

		// Band/point y scale
		if (
			!skipBandIndex &&
			(this.actualYScaleType === 'band' || this.actualYScaleType === 'point')
		) {
			const yScale = this.#chartContext.yScaleState as BandScaleState | null;
			if (yScale?.caseExpression) {
				select.y = sql`${yScale.caseExpression}`;
			}
		}

		// Ordinal color scale
		const colorKey = this.#config.colorChannel || 'fill';
		if (this.#colorScaleState?.caseExpression) {
			select[colorKey] = sql`${this.#colorScaleState.caseExpression}`;
		}
	}

	/**
	 * Inline time offset expressions for time scales.
	 * Replaces ViewManager's offset column with direct SQL in the SELECT.
	 */
	#inlineTimeOffsets(select: Record<string, unknown>): void {
		if (this.actualXScaleType === 'time' && typeof this.#config.select.x === 'string') {
			const xScale = this.#chartContext.xScaleState as TimeScaleState | null;
			if (xScale?.offsetExpression) {
				select.x = sql`${xScale.offsetExpression}`;
			}
		}
		if (this.actualYScaleType === 'time' && typeof this.#config.select.y === 'string') {
			const yScale = this.#chartContext.yScaleState as TimeScaleState | null;
			if (yScale?.offsetExpression) {
				select.y = sql`${yScale.offsetExpression}`;
			}
		}
	}

	async #executeQuery(sqlStr: string): Promise<void> {
		if (this.#destroyed) return;

		try {
			const result = await this.#queryEngine.query(sqlStr, { callerId: this.#markId });
			if (this.#destroyed) return;

			this.#arrowTable = result;
			this.#dataVersion++;

			// Register data-derived domains (aggregates, transforms)
			if (!this.#config.passiveScales && result.numRows > 0) {
				const data = this.data;
				if (data) {
					const additionalChannels = this.#transformCompiler.getAdditionalChannels();
					const xState = this.#chartContext.xScaleState as ContinuousScaleState | null;
					const yState = this.#chartContext.yScaleState as ContinuousScaleState | null;

					const domainResult = registerDataDerivedDomains(
						data,
						this.#channelsNeedingDataDomain,
						additionalChannels,
						this.#skipDomainUpdateForAxis,
						this.#config.zeroBaseline,
						this.actualXScaleType,
						this.actualYScaleType,
						xState,
						yState,
						this.#transformCompiler.hasCategoryReducingTransforms(),
						this.#chartContext.xScaleState as BandScaleState | null,
						this.#chartContext.yScaleState as BandScaleState | null,
						this.#markId,
						false, // isRebinning
						this.#colorScaleState
					);
					this.#dataDerivedDomainsSet = domainResult.dataDerivedDomainsSet;
					this.#skipDomainUpdateForAxis = domainResult.skipDomainUpdateForAxis;

					// Mark deferred scales ready
					markDeferredScalesReady(
						this.#scaleMap,
						this.#channelsNeedingDataDomain,
						this.actualXScaleType,
						this.actualYScaleType
					);
				}
			}
		} catch (error) {
			if ((error as Error)?.name === 'AbortError') return; // Superseded — not an error
			console.error(`[MarkLifecycleV2] Query failed for ${this.#markId}:`, error);
		}
	}

	/**
	 * Build a query for fetchGlobalAggregates.
	 * This is the queryBuilder callback that the aggregates fetcher uses
	 * to wrap the mark's query as a derived table for MIN/MAX computation.
	 */
	#buildQueryForAggregates(
		_table: string,
		_config: any,
		filter: unknown[]
	): Query | null {
		const sqlStr = this.#buildQueryString(filter as FilterExpr[]);
		if (!sqlStr) return null;
		return Query.from(sql`(${sqlStr})` as any);
	}

	// ===========================================================================
	// PUBLIC API (consumed by mark components)
	// ===========================================================================

	get actualXScaleType(): string {
		return this.#chartContext.scaleTypes?.x || 'linear';
	}

	get actualYScaleType(): string {
		return this.#chartContext.scaleTypes?.y || 'linear';
	}

	get markId(): string {
		return this.#markId;
	}

	get tooltipTableName(): string {
		return this.#tooltipTableName;
	}

	get tooltipEnabled(): boolean {
		return this.#config.tooltip !== false && this.#tooltipTableReady;
	}

	get channelFieldMap(): Record<string, string> {
		return buildChannelFieldMap(this.#config.select);
	}

	get dataVersion(): number {
		return this.#dataVersion;
	}

	get hasCategoryReducingTransforms(): boolean {
		return this.#transformCompiler.hasCategoryReducingTransforms();
	}

	// Processed data with JS transforms applied
	data: DataAccessor | null = $derived.by(() => {
		if (!this.#arrowTable) return null;

		let accessor: DataAccessor = new ArrowDataAccessor(
			this.#arrowTable,
			this.#cachedQueryParts?.aliasMap
		);

		// Fast path: no JS transforms
		if (!this.#transformCompiler.hasJSTransforms()) {
			return accessor;
		}

		// Inject constant channel values as overlays
		const constants = this.#config.constants;
		if (constants) {
			const overlays: Record<string, Float32Array> = {};
			for (const key in constants) {
				if (accessor.getColumn(key) === null) {
					const arr = new Float32Array(accessor.length);
					arr.fill(constants[key]);
					overlays[key] = arr;
				}
			}
			if (Object.keys(overlays).length > 0) {
				accessor = accessor.withOverlays(overlays);
			}
		}

		const transformConfig = {
			markType: this.#config.markType,
			table: this.#config.table,
			x: this.#getFieldName('x'),
			y: this.#getFieldName('y'),
			fill: this.#getFieldName('fill')
		};

		return this.#transformCompiler.applyToData(accessor, transformConfig, {
			x: this.#chartContext.xScale,
			y: this.#chartContext.yScale
		});
	});

	/** Facet index data for GPU upload. */
	facetData: Float32Array | null = $derived.by(() => {
		if (!this.#chartContext.fx || !this.data) return null;
		const raw = this.data.getColumn('__facet');
		if (!raw) return null;
		return raw instanceof Float32Array ? raw : new Float32Array(raw as ArrayLike<number>);
	});

	gpuReady: boolean = $derived.by(() => {
		if (!this.setupComplete) return false;

		const xSS = this.#chartContext.xScaleState;
		const xReady =
			this.actualXScaleType === 'band' || this.actualXScaleType === 'point'
				? (xSS as BandScaleState | null | undefined)?.isReadyForGPU
				: xSS?.ready;

		if (this.#config.parallelMode) {
			if (!xReady) return false;
			for (const [key, scale] of Object.entries(this.#scaleMap)) {
				if (key === 'x' || key === 'y') continue;
				if (scale && !scale.ready) return false;
			}
			return true;
		}

		if (!this.#chartContext.scalesReady) return false;

		const ySS = this.#chartContext.yScaleState;
		const yReady =
			this.actualYScaleType === 'band' || this.actualYScaleType === 'point'
				? (ySS as BandScaleState | null | undefined)?.isReadyForGPU
				: ySS?.ready;

		return !!(xReady && yReady);
	});

	// ===========================================================================
	// SCALE SETTERS (called by MarkColor, MarkSize, MarkSeries)
	// ===========================================================================

	setColorScale(colorScaleState: ColorScaleState): void {
		this.#colorScaleState = colorScaleState;
	}

	setSeriesScale(seriesScaleState: ColorScaleState): void {
		this.#seriesScaleState = seriesScaleState;
	}

	setSizeScale(sizeScaleState: SizeScaleState): void {
		this.#sizeScaleState = sizeScaleState;
	}

	// ===========================================================================
	// HELPERS
	// ===========================================================================

	#getFieldName(channel: string): string {
		if (this.#config.select[channel] != null) return channel;
		const constants = this.#config.constants;
		if (constants && constants[channel] != null) return channel;
		if (channel === 'x') {
			if (this.#config.select.x2 != null) return 'x2';
			if (this.#config.select.x1 != null) return 'x1';
			if (constants?.x2 != null) return 'x2';
			if (constants?.x1 != null) return 'x1';
		}
		if (channel === 'y') {
			if (this.#config.select.y2 != null) return 'y2';
			if (this.#config.select.y1 != null) return 'y1';
			if (constants?.y2 != null) return 'y2';
			if (constants?.y1 != null) return 'y1';
		}
		return channel;
	}

	// ===========================================================================
	// CLEANUP
	// ===========================================================================

	destroy(): void {
		this.#destroyed = true;
		this.#queryEngine.cancel(this.#markId);
		this.#arrowTable = null;
	}
}
