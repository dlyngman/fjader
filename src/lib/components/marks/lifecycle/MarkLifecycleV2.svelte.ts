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
	isColumnRef,
	isAggregateExpression,
	sql,
	column as sqlColumn,
	cast,
	coalesce,
	min,
	max,
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
import { buildSchemaMap, type ColumnSchema } from '$lib/query-engine/QueryEngine';
import { type AutoBinNode, isBinExpression } from '$lib/sql/bin';
import { type RollingAvgNode, isRollingAvgExpression } from '$lib/sql/rolling-avg';
import { isWindowExpression } from '$lib/sql/expression-utils';
import { AdaptiveBinRung } from '$lib/lod/AdaptiveBinRung.svelte';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import { generateMarkId, buildChannelFieldMap } from '../utils';
import { buildExpressionLabel, isLabeledTipEntry } from '../utils/channel-field-map';
import { detectChannelsNeedingDataDomain } from './domain-computation';
import { buildQueryParts, assembleQuery, type QueryParts } from './query-builder';
import {
	setScalesReady,
	markDeferredScalesReady,
	setInitialContinuousDomains,
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
	#queryPartsStale = $state(false);
	#fieldStats: Record<string, { column: string; min: number; max: number }> | null = null;
	#schema: Map<string, ColumnSchema> | null = null;
	#lastBinDomain: Record<string, [number, number]> = {};
	#adaptiveBinRung: AdaptiveBinRung | null = null;

	// --- Domain State ---
	#channelsNeedingDataDomain: Set<string> = new Set();
	#dataDerivedDomainsSet = $state(false);
	#globalAggregatesSet = $state(false);
	#skipDomainUpdateForAxis: string | null = null;
	#lastBandDomainDataVersion: number | null = null;

	// --- Tooltip ---
	#tooltipWanted: boolean;
	#tooltipTableName: string;
	#tooltipTableReady = $state(false);
	#tooltipSortTable: boolean;
	#tooltipWriteTimeout: ReturnType<typeof setTimeout> | null = null;

	// --- fitDomain ---
	#fitDomainTimeout: ReturnType<typeof setTimeout> | null = null;
	#fitDomainLastTarget: [number, number] = [0, 0];
	#fitDomainQuerySequence = 0;
	#fitDomainSuppressed = false;

	// --- Cleanup ---
	#destroyed = false;

	constructor(
		config: MarkLifecycleV2Config,
		queryEngine: QueryEngine,
		chartContext: ChartContext,
		markId: string,
		selection: CrossfilterSelection | null,
		options?: { gpuCoordinator?: GPUCoordinator | null; onMarkLOD?: ((surface: any) => void) | null }
	) {
		this.#config = config;
		this.#queryEngine = queryEngine;
		this.#chartContext = chartContext;
		this.#markId = markId;
		this.#selection = selection;

		// Tooltip config
		this.#tooltipWanted = config.tooltip !== false || !!config.fitDomain;
		this.#tooltipSortTable =
			typeof config.tooltip === 'object' ? config.tooltip.sortTable !== false : true;
		this.#tooltipTableName = `_tt_${this.#markId.replace(/-/g, '_')}`;

		// Transform compiler
		this.#transformCompiler = new TransformCompiler(config.transforms || []);
		this.#detectAutoBins();

		// AdaptiveBinRung for binned marks (watches viewport domain, triggers rebin)
		if (this.#autoBinNodes.size > 0 && options?.gpuCoordinator) {
			const binAxes = [...this.#autoBinNodes.keys()].map(
				(ch) => (ch.startsWith('x') ? 'x' : 'y') as 'x' | 'y'
			);
			this.#adaptiveBinRung = new AdaptiveBinRung(options.gpuCoordinator, chartContext, {
				binAxes,
				binningThreshold: 1.5,
				setParam: (_key, value) => {
					const e = chartContext.config.entries.get(markId);
					if (!e) return;
					const current = e.lod;
					const cfg = typeof current === 'object' && current ? current : {};
					chartContext.config.setMarkProp(markId, 'lod', { ...cfg, multiplier: value });
				},
				getData: () => this.data,
				triggerReBin: (axis, domain) => {
					this.#lastBinDomain[axis] = [domain[0], domain[1]];
					this.#skipDomainUpdateForAxis = axis;
					this.#dataDerivedDomainsSet = false;
					this.#queryPartsStale = true;
				}
			});
			if (options.onMarkLOD) {
				chartContext.config.registerMarkLOD(markId, this.#adaptiveBinRung as any);
				options.onMarkLOD(this.#adaptiveBinRung as any);
			}
		}

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

			// Establish reactive dependencies on scale states so the query
			// re-fires when domains change (band reorder, color domain update)
			void this.#chartContext.xScaleState;
			void this.#chartContext.yScaleState;
			// Re-fire when query parts are invalidated (e.g. LOD window size change)
			void this.#queryPartsStale;

			// Build the SQL (synchronous — uses cached query parts)
			const sqlStr = this.#buildQueryString(filter);
			if (!sqlStr) return;

			untrack(() => {
				this.#executeQuery(sqlStr);
			});
		});

		// Side concern: Invalidate query cache when binStepMultiplier changes
		// (shift+scroll on binned marks). Phase 2 reads #queryPartsStale and rebuilds.
		if (this.#autoBinNodes.size > 0) {
			$effect(() => {
				void this.#chartContext.binStepMultiplier;
				this.#queryPartsStale = true;
			});
		}

		// Side concern: Write tooltip table when data updates (debounced).
		// Trigger on dataVersion rather than this.data — data recomputes on
		// every scale change which would reset the debounce timer indefinitely.
		$effect(() => {
			if (!this.#tooltipWanted) return;
			const dataVersion = this.#dataVersion;
			if (dataVersion === 0) return;

			untrack(() => {
				clearTimeout(this.#tooltipWriteTimeout!);
				this.#tooltipWriteTimeout = setTimeout(() => {
					const data = this.data;
					if (data && data.length > 0) this.#writeTooltipTable(data);
				}, 300);
			});
		});

		// Side concern: fitDomain — query DuckDB for fitted axis extent on
		// driving axis change. Suppressed when the user directly interacts with
		// the fitted axis. Re-enabled when the driving axis changes from a
		// non-user source (e.g., overview brush).
		$effect(() => {
			const fitDomain = this.#config.fitDomain;
			if (!fitDomain) return;
			if (!this.#dataDerivedDomainsSet) return;

			const fittedAxis = this.#resolveFittedAxis(fitDomain);
			if (!fittedAxis) return;

			const drivingAxis = fittedAxis === 'y' ? 'x' : 'y';
			const drivingSS =
				drivingAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
			if (!drivingSS || drivingSS.scaleType === 'band') return;

			const target = drivingSS.domain?.target;
			if (!target) return;

			const fittedSS =
				fittedAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
			const fittedUserDriven = (fittedSS as ContinuousScaleState | null)?.userDriven ?? false;
			const drivingUserDriven = (drivingSS as ContinuousScaleState).userDriven;

			// Tell the fitted scale to skip disjoint-domain instant snap —
			// fitDomain intentionally produces large domain jumps that should animate.
			if (fittedSS) {
				(fittedSS as ContinuousScaleState).fitDomainActive = true;
			}

			untrack(() => {
				if (fittedUserDriven) {
					this.#fitDomainSuppressed = true;
				}
				if (this.#fitDomainSuppressed && !drivingUserDriven) {
					this.#fitDomainSuppressed = false;
				}
				if (this.#fitDomainSuppressed) return;

				clearTimeout(this.#fitDomainTimeout!);
				this.#fitDomainTimeout = setTimeout(() => {
					this.#issueFitDomainQuery(fittedAxis, target as [number, number]);
				}, 200);
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

			// Batch all domain queries + schema fetch in parallel
			const [schemaColumns, fetchCount, aggResult, fieldStats] = await Promise.all([
				// Fetch table schema (cached on QueryEngine, needed for CAST type decisions)
				this.#queryEngine.describe(this.#config.table),
				fetchCategoricalDomains(
					this.#queryEngine,
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
					this.#queryEngine,
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
				),
				this.#fetchFieldStats()
			]);

			if (this.#destroyed) return;

			this.#schema = buildSchemaMap(schemaColumns);
			if (aggResult.globalAggregatesSet) this.#globalAggregatesSet = true;

			// Store field stats for autobin resolution in #buildQueryString
			this.#fieldStats = fieldStats;

			// Set continuous domains from field stats (replaces old Effect 5 fieldInfo path)
			if (fieldStats) {
				setInitialContinuousDomains(
					fieldStats,
					this.#scaleMap,
					this.#config.select,
					this.actualXScaleType,
					this.actualYScaleType,
					this.#markId
				);
			}

			// Mark scales ready
			setScalesReady(
				this.#scaleMap,
				this.#channelsNeedingDataDomain,
				this.actualXScaleType,
				this.actualYScaleType,
				this.#globalAggregatesSet,
				this.#dataDerivedDomainsSet
			);

			// Invalidate cached query parts — setup resolved scale domains that
			// enable CASE expression inlining (ordinal color, band scales).
			// Phase 2 will rebuild with the now-available expressions.
			this.#queryPartsStale = true;
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

			const resolvedSelect = { ...this.#config.select };

			// Resolve AutoBinNodes to SQL bin expressions.
			// Uses #lastBinDomain (set by AdaptiveBinRung on zoom threshold crossing)
			// for viewport-adaptive bin count. Falls back to null (full field extent)
			// for initial render.
			if (this.#autoBinNodes.size > 0 && this.#fieldStats) {
				const binStepMultiplier = this.#chartContext.binStepMultiplier || 1.0;
				for (const [ch, value] of Object.entries(resolvedSelect)) {
					if (isBinExpression(value)) {
						const axis = ch.startsWith('x') ? 'x' : 'y';
						const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
						const currentDomain = this.#lastBinDomain[axis] ?? null;
						resolvedSelect[ch] = value.resolve(
							this.#fieldStats as Record<string, { min?: number; max?: number; type?: string }>,
							scaleType,
							null,
							currentDomain,
							binStepMultiplier
						);
					}
				}
			}

			// Resolve RollingAvgNodes to SQL window expressions
			for (const [ch, value] of Object.entries(resolvedSelect)) {
				if (isRollingAvgExpression(value)) {
					resolvedSelect[ch] = value.resolve();
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

		// Build a Float32-safe selectDef for the query. COALESCE(CAST(... AS REAL), 'NaN'::REAL)
		// on numeric channels ensures DuckDB returns Float32Array (not BigInt64Array).
		// Uses the cached table schema to determine column types — only numeric columns
		// and computed expressions (aggregates, CASE) get CAST. String and date columns
		// are skipped (dates use epoch offset via #inlineTimeOffsets instead).
		const { selectDef, nonAggregateGroupBy, hasAggregates } = this.#cachedQueryParts;
		const castSelectDef = { ...selectDef };
		const schema = this.#schema;

		for (const [ch, expr] of Object.entries(castSelectDef)) {
			if (expr == null) continue;

			// Aggregates and window functions always produce numeric output — CAST them
			if (isAggregateExpression(expr as any) || isWindowExpression(expr as any)) {
				castSelectDef[ch] = coalesce(cast(expr, 'REAL'), sql`'NaN'::REAL`);
				continue;
			}

			// Non-column SQL nodes (CASE expressions from inlining) are already numeric
			if (isNode(expr) && !isColumnRef(expr as any)) {
				castSelectDef[ch] = coalesce(cast(expr, 'REAL'), sql`'NaN'::REAL`);
				continue;
			}

			// Column references: check the source column type from the schema
			if (isColumnRef(expr as any)) {
				const colName = (expr as any).column as string;
				const jsType = schema?.get(colName)?.jsType;
				// Only CAST numeric columns (skip string, date, boolean)
				if (jsType === 'number') {
					castSelectDef[ch] = coalesce(cast(expr, 'REAL'), sql`'NaN'::REAL`);
				}
			}
		}

		const castParts = { ...this.#cachedQueryParts, selectDef: castSelectDef };
		const q = assembleQuery(
			this.#config.table,
			castParts,
			filter as unknown[],
			this.#config._filterNulls ?? null,
			this.#transformCompiler,
			false, // forMosaic — always false in V2 (channel names throughout)
			undefined
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
	/**
	 * Inline time offset expressions for time scales.
	 * Replaces ViewManager's offset column with direct SQL in the SELECT.
	 * Handles base channel + extent variants (x1/x2, y1/y2 from bin expansion).
	 */
	#inlineTimeOffsets(select: Record<string, unknown>): void {
		for (const [axis, channels] of [
			['x', ['x', 'x1', 'x2']],
			['y', ['y', 'y1', 'y2']]
		] as const) {
			const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
			if (scaleType !== 'time') continue;
			const scaleState = this.#chartContext[`${axis}ScaleState`] as TimeScaleState | null;
			if (!scaleState?.t0) continue;

			const t0Epoch = Math.floor(scaleState.t0.getTime() / 1000);

			for (const ch of channels) {
				if (!(ch in select)) continue;
				const val = select[ch];
				if (typeof val === 'string') {
					if (scaleState.offsetExpression) {
						select[ch] = sql`${scaleState.offsetExpression}`;
					}
				} else if (isNode(val)) {
					select[ch] = sql`CAST((epoch(${val}) - ${t0Epoch}) AS REAL)`;
				}
			}
		}
	}

	/**
	 * Fetch MIN/MAX stats for continuous scale fields.
	 * Replaces Mosaic's queryFieldInfo (old Effect 5 fieldInfo path).
	 * Returns a fieldInfo-shaped map for setInitialContinuousDomains.
	 */
	async #fetchFieldStats(): Promise<Record<string, { column: string; min: number; max: number }> | null> {
		const select = this.#config.select;
		const fields: { key: string; expr: unknown }[] = [];

		// Iterate scaleMap — it has exactly the channels that need domains:
		// x/y for normal marks, plus each parallel column for parallel mode.
		for (const alias of Object.keys(this.#scaleMap)) {
			if (!this.#scaleMap[alias]) continue;
			const scaleType = alias === 'x' ? this.actualXScaleType
				: alias === 'y' ? this.actualYScaleType
				: 'linear'; // parallel columns are always linear

			// Check alias + extent variants (x1/x2, y1/y2)
			for (const key of [alias, `${alias}1`, `${alias}2`]) {
				const expr = select[key];
				if (expr == null) continue;
				// Bin expressions always need field stats (MIN/MAX for bin boundaries),
				// regardless of scale type (including time scales).
				if (isBinExpression(expr)) {
					fields.push({ key, expr: expr.field });
					continue;
				}
				if (!isNumericScale(scaleType)) continue;
				if (isNode(expr) && isAggregateExpression(expr as any)) continue;
				if (isNode(expr) && isWindowExpression(expr as any)) continue;
				fields.push({ key, expr });
			}
		}

		if (fields.length === 0) return null;

		// Deduplicate by string representation
		const seen = new Set<string>();
		const unique = fields.filter((f) => {
			const s = String(f.expr);
			if (seen.has(s)) return false;
			seen.add(s);
			return true;
		});

		// Build a single query with MIN/MAX for each field.
		// Numeric fields get CAST to REAL. Date/timestamp fields from bin
		// expressions are left uncast — DuckDB returns Date objects that
		// we convert to epoch ms in JS (same as fetchCategoricalDomains).
		// describe() is cached on QueryEngine, so this await is free if
		// it's already running in parallel from the same Promise.all.
		const schema = buildSchemaMap(await this.#queryEngine.describe(this.#config.table));
		const selectDef: Record<string, unknown> = {};
		for (let i = 0; i < unique.length; i++) {
			const colExpr = isNode(unique[i].expr)
				? unique[i].expr
				: sqlColumn(String(unique[i].expr));
			const colName = String(unique[i].expr).replace(/^["']|["']$/g, '');
			const jsType = schema?.get(colName)?.jsType;
			if (jsType === 'date') {
				// Date columns: raw MIN/MAX, convert to epoch ms in JS
				selectDef[`min_${i}`] = min(colExpr as ExprValue);
				selectDef[`max_${i}`] = max(colExpr as ExprValue);
			} else {
				selectDef[`min_${i}`] = cast(min(colExpr as ExprValue), 'REAL');
				selectDef[`max_${i}`] = cast(max(colExpr as ExprValue), 'REAL');
			}
		}

		const q = Query.from(this.#config.table).select(selectDef as Record<string, ExprValue>);
		const result = await this.#queryEngine.query(q);
		const row = result.get(0) as Record<string, unknown> | null;
		if (!row) return null;

		// Build fieldInfo-shaped result keyed by the field's string representation
		// (matches how setInitialContinuousDomains looks up by String(fieldValue))
		const stats: Record<string, { column: string; min: number; max: number }> = {};
		for (let i = 0; i < unique.length; i++) {
			const minVal = row[`min_${i}`];
			const maxVal = row[`max_${i}`];
			if (minVal != null && maxVal != null) {
				const fieldStr = String(unique[i].expr).replace(/^["']|["']$/g, '');
				stats[fieldStr] = {
					column: fieldStr,
					min: Number(minVal),
					max: Number(maxVal)
				};
			}
		}
		return stats;
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
				// Once domains are derived from the first query result, skip
				// re-registration on subsequent results (e.g., crossfilter updates).
				// Exception: topN marks need band domain re-derivation on new data.
				if (this.#dataDerivedDomainsSet) {
					if (
						this.#transformCompiler.hasCategoryReducingTransforms() &&
						this.#dataVersion !== this.#lastBandDomainDataVersion
					) {
						this.#lastBandDomainDataVersion = this.#dataVersion;
					} else {
						return;
					}
				}

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
		return Query.from(sql`(${sqlStr})` as any).select('*');
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

		// No aliasMap needed — with forMosaic=false, the query SELECT uses
		// channel names as aliases, so Arrow column names are already x, y, fill, etc.
		let accessor: DataAccessor = new ArrowDataAccessor(this.#arrowTable);

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
	// TOOLTIP WRITE-BACK
	// ===========================================================================

	async #writeTooltipTable(data: DataAccessor): Promise<void> {
		const tableName = this.#tooltipTableName;
		try {
			if (!this.#transformCompiler.hasJSTransforms()) {
				// Path A: Build a query with original field names (not CAST-wrapped).
				// Uses channel-named aliases so tooltip columns match expectations.
				const tooltipQuery = this.#buildTooltipQuery();
				if (!tooltipQuery) return;

				// Pre-cast numeric axis columns to DOUBLE (avoids DECIMAL overflow
				// in distance math). Build REPLACE clause dynamically.
				const selectConfig = this.#config.select;
				const castCols = ['x', 'x1', 'x2', 'y', 'y1', 'y2'].filter((c) => c in selectConfig);
				const replaceClause =
					castCols.length > 0
						? ` REPLACE (${castCols.map((c) => `CAST(${c} AS DOUBLE) AS ${c}`).join(', ')})`
						: '';

				// Optional ORDER BY for zone-map skipping in bounding-box queries.
				let orderClause = '';
				if (this.#tooltipSortTable) {
					const orderCol = ['x', 'x1', 'x2'].find((c) => c in selectConfig);
					if (orderCol) orderClause = ` ORDER BY ${orderCol}`;
				}

				await this.#queryEngine.exec([
					`DROP TABLE IF EXISTS "${tableName}"`,
					`CREATE TEMP TABLE "${tableName}" AS SELECT *${replaceClause} FROM (${tooltipQuery})${orderClause}`
				]);
			} else {
				// Path B: Serialize transformed data via SQL VALUES.
				// JS transforms produce small datasets (tens of rows).
				const columns = data.columnNames.filter((c) => !c.startsWith('__dplot_'));
				if (columns.length === 0) return;

				const columnArrays: Record<string, ArrayLike<unknown>> = {};
				for (const col of columns) {
					const colData = data.getColumn(col);
					if (colData) columnArrays[col] = colData;
				}

				// Band axis columns from category-reducing transforms contain
				// strings — convert to integer indices for the tooltip pipeline.
				const bandIndexMaps: Record<string, ReadonlyMap<string, number>> = {};
				const xss = this.#chartContext.xScaleState;
				if (this.actualXScaleType === 'band' && xss && 'categoryIndexMap' in xss) {
					bandIndexMaps['x'] = xss.categoryIndexMap;
				}
				const yss = this.#chartContext.yScaleState;
				if (this.actualYScaleType === 'band' && yss && 'categoryIndexMap' in yss) {
					bandIndexMaps['y'] = yss.categoryIndexMap;
				}

				// Infer schema from first row
				const schemaDef = columns
					.map((col) => {
						if (bandIndexMaps[col]) return `"${col}" INTEGER`;
						const sample = columnArrays[col]?.[0];
						const sqlType = typeof sample === 'number' ? 'DOUBLE' : 'VARCHAR';
						return `"${col}" ${sqlType}`;
					})
					.join(', ');

				// Build VALUES rows
				const valueRows: string[] = [];
				for (let i = 0; i < data.length; i++) {
					const vals = columns.map((col) => {
						const v = columnArrays[col]?.[i];
						if (v == null || (typeof v === 'number' && isNaN(v))) return 'NULL';
						const bandMap = bandIndexMaps[col];
						if (bandMap && typeof v === 'string') {
							const idx = bandMap.get(v);
							return idx != null ? idx.toString() : 'NULL';
						}
						if (typeof v === 'number') return v.toString();
						return `'${String(v).replace(/'/g, "''")}'`;
					});
					valueRows.push(`(${vals.join(', ')})`);
				}

				await this.#queryEngine.exec([
					`DROP TABLE IF EXISTS "${tableName}"`,
					`CREATE TEMP TABLE "${tableName}" (${schemaDef})`,
					`INSERT INTO "${tableName}" VALUES ${valueRows.join(', ')}`
				]);
			}

			// Merge tip expression extras (aggregates/windows) via sidecar query.
			const tipExtras = this.#getTipExtras();
			if (Object.keys(tipExtras).length > 0) {
				try {
					await this.#mergeTipExtras(tableName, tipExtras);
				} catch (err) {
					console.warn('Failed to merge tip extras into tooltip table:', err);
				}
			}

			this.#tooltipTableReady = true;
			this.#onTooltipTableWritten();
		} catch (error) {
			console.error(`Failed to write tooltip table "${tableName}":`, error);
		}
	}

	/**
	 * Build a tooltip query using original field names (not CAST-wrapped).
	 * Uses the same query assembly path but without Float32 coercion.
	 */
	#buildTooltipQuery(): string | null {
		if (!this.#cachedQueryParts) return null;
		const filter = this.#selection?.predicate(this.#markId) ?? [];

		const q = assembleQuery(
			this.#config.table,
			this.#cachedQueryParts,
			filter as unknown[],
			this.#config._filterNulls ?? null,
			this.#transformCompiler,
			false,
			undefined
		);
		if (!q) return null;
		if (this.#config.clientOptions?.limit) {
			q.limit(this.#config.clientOptions.limit);
		}
		return q.toString();
	}

	/** Extract expression nodes from the tip prop as { label: exprNode } pairs. */
	#getTipExtras(): Record<string, unknown> {
		const extras: Record<string, unknown> = {};
		const tipEntries = this.#config.tip;
		if (!tipEntries) return extras;
		for (const entry of tipEntries) {
			if (entry === '*' || typeof entry === 'string') continue;
			if (isLabeledTipEntry(entry)) {
				if (isNode(entry.value)) {
					extras[entry.label] = entry.value;
				}
				continue;
			}
			if (!isNode(entry)) continue;
			const label = buildExpressionLabel(entry);
			if (label) extras[label] = entry;
		}
		return extras;
	}

	/**
	 * Merge tip expression extras into the tooltip temp table via a sidecar
	 * DB query. Computes aggregates against the source table using the same
	 * GROUP BY as the main query, then ALTER+UPDATE the temp table.
	 */
	async #mergeTipExtras(
		tableName: string,
		tipExtras: Record<string, unknown>
	): Promise<void> {
		if (!this.#cachedQueryParts) return;

		// Identify non-aggregate channel columns — these are the join keys
		const joinCols: string[] = [];
		for (const [ch, expr] of Object.entries(this.#cachedQueryParts.selectDef)) {
			if (!isAggregateExpression(expr as any) && !isWindowExpression(expr as any)) {
				joinCols.push(ch);
			}
		}

		// Build sidecar select: group-by columns + tip extras
		const sidecarSelect: Record<string, unknown> = {};
		for (const ch of joinCols) {
			sidecarSelect[ch] = this.#cachedQueryParts.selectDef[ch];
		}
		Object.assign(sidecarSelect, tipExtras);

		const sidecarParts = buildQueryParts(
			sidecarSelect,
			undefined,
			this.#transformCompiler.hasSQLTransforms()
		);

		const filter = this.#selection?.predicate(this.#markId) ?? [];
		const sidecarQuery = assembleQuery(
			this.#config.table,
			sidecarParts,
			filter as unknown[],
			this.#config._filterNulls ?? null,
			this.#transformCompiler,
			false
		);
		if (!sidecarQuery) return;

		// ALTER TABLE to add columns, then UPDATE from sidecar query
		const alterStmts = Object.keys(tipExtras).map(
			(col) => `ALTER TABLE "${tableName}" ADD COLUMN "${col}" DOUBLE`
		);
		const setClauses = Object.keys(tipExtras)
			.map((col) => `"${col}" = _s."${col}"`)
			.join(', ');
		const joinCondition = joinCols
			.map((ch) => `"${tableName}"."${ch}" = _s."${ch}"`)
			.join(' AND ');
		const updateStmt = `UPDATE "${tableName}" SET ${setClauses} FROM (${sidecarQuery.toString()}) _s WHERE ${joinCondition}`;

		await this.#queryEngine.exec([...alterStmts, updateStmt]);
	}

	// ===========================================================================
	// FIT DOMAIN
	// ===========================================================================

	#resolveFittedAxis(fitDomain: 'x' | 'y' | boolean): 'x' | 'y' | null {
		if (fitDomain === 'x') return 'x';
		if (fitDomain === 'y') return 'y';
		const xHasBins = this.#autoBinNodes.has('x1') || this.#autoBinNodes.has('x2');
		const yHasBins = this.#autoBinNodes.has('y1') || this.#autoBinNodes.has('y2');
		if (xHasBins && !yHasBins) return 'y';
		if (yHasBins && !xHasBins) return 'x';
		return 'y';
	}

	#getFitDomainChannels(axis: 'x' | 'y', includeTransformChannels: boolean): string[] {
		const select = this.#config.select;
		const candidates = [axis, `${axis}1`, `${axis}2`];
		const channels = candidates.filter((c) => c in select);

		if (includeTransformChannels) {
			const additionalChannels = this.#transformCompiler.getAdditionalChannels();
			const stackCandidates = [`${axis}0`, `${axis}1`];
			for (const ch of stackCandidates) {
				if (additionalChannels.includes(ch) && !channels.includes(ch)) {
					channels.push(ch);
				}
			}
		}

		return channels;
	}

	async #issueFitDomainQuery(
		fittedAxis: 'x' | 'y',
		drivingDomain: [number, number] | null,
		force: boolean = false
	): Promise<void> {
		if (!force && drivingDomain) {
			const [lastLo, lastHi] = this.#fitDomainLastTarget;
			const lastWidth = lastHi - lastLo;
			const curWidth = drivingDomain[1] - drivingDomain[0];
			if (lastWidth > 0 && curWidth > 0) {
				const ratio = lastWidth / curWidth;
				const shift = Math.abs(drivingDomain[0] - lastLo) / curWidth;
				if (ratio > 0.95 && ratio < 1.05 && shift < 0.02) return;
			}
		}

		const seq = ++this.#fitDomainQuerySequence;

		try {
			const q = this.#buildFitDomainQuery(fittedAxis, drivingDomain);
			if (!q) return;

			const result = await this.#queryEngine.query(q.toString(), {
				callerId: `${this.#markId}:fitDomain`
			});
			if (seq !== this.#fitDomainQuerySequence) return;

			const row = result.get(0) as Record<string, number> | undefined;
			if (!row) return;

			let lo = Infinity;
			let hi = -Infinity;
			for (const [key, val] of Object.entries(row)) {
				if (val == null || !isFinite(val as number)) continue;
				if (key.startsWith('min_') && (val as number) < lo) lo = val as number;
				if (key.startsWith('max_') && (val as number) > hi) hi = val as number;
			}
			if (lo >= hi) return;

			if (this.#config.zeroBaseline?.[fittedAxis]) {
				lo = Math.min(0, lo);
				hi = Math.max(0, hi);
			}

			const scaleState =
				fittedAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
			const scaleType = fittedAxis === 'x' ? this.actualXScaleType : this.actualYScaleType;
			if (scaleType === 'time' && scaleState && 'addOffsetExtent' in scaleState) {
				(scaleState as TimeScaleState).addOffsetExtent([lo, hi], this.#markId);
			} else if (scaleState && 'addMark' in scaleState) {
				(scaleState as ContinuousScaleState).addMark([lo, hi], this.#markId);
			}

			if (drivingDomain) this.#fitDomainLastTarget = [...drivingDomain];
		} catch (e) {
			// Silently ignore — query may fail during teardown or table recreation
		}
	}

	#buildFitDomainQuery(
		fittedAxis: 'x' | 'y',
		drivingDomain: [number, number] | null
	): Query | null {
		const useTooltipTable = this.#transformCompiler.hasJSTransforms() && this.#tooltipTableReady;

		const fittedChannels = this.#getFitDomainChannels(fittedAxis, useTooltipTable);
		if (fittedChannels.length === 0) return null;

		const outerSelect: Record<string, unknown> = {};
		for (const ch of fittedChannels) {
			outerSelect[`min_${ch}`] = min(sqlColumn(ch));
			outerSelect[`max_${ch}`] = max(sqlColumn(ch));
		}

		let whereClause: unknown = undefined;
		if (drivingDomain) {
			const drivingAxis = fittedAxis === 'y' ? 'x' : 'y';
			const drivingChannels = this.#getFitDomainChannels(drivingAxis, useTooltipTable);
			whereClause = this.#buildFitDomainWhere(drivingChannels, drivingDomain);
		}

		if (useTooltipTable) {
			const q = Query.from(this.#tooltipTableName)
				.select(outerSelect as Record<string, ExprValue>);
			if (whereClause) q.where(whereClause as any);
			return q;
		}

		// Path A: CTE-wrap the mark's base query
		return this.#buildSidecarQuery(outerSelect, whereClause);
	}

	#buildFitDomainWhere(
		drivingChannels: string[],
		domain: [number, number]
	): unknown {
		const [lo, hi] = domain;
		const ch1 = drivingChannels.find((c) => c.endsWith('1'));
		const ch2 = drivingChannels.find((c) => c.endsWith('2'));
		if (ch1 && ch2) {
			return sql`${sqlColumn(ch2)} >= ${lo} AND ${sqlColumn(ch1)} <= ${hi}`;
		}
		const ch = drivingChannels[0];
		if (ch) {
			return sql`${sqlColumn(ch)} BETWEEN ${lo} AND ${hi}`;
		}
		return undefined;
	}

	/**
	 * Build a sidecar query by wrapping this mark's base query as a derived table.
	 * Used by fitDomain (MIN/MAX) and potentially DensityHost (COUNT).
	 */
	#buildSidecarQuery(
		outerSelect: Record<string, unknown>,
		where?: unknown
	): Query | null {
		const tooltipQuery = this.#buildTooltipQuery();
		if (!tooltipQuery) return null;
		const q = Query.from({ mark_data: sql`(${tooltipQuery})` as any })
			.select(outerSelect as Record<string, ExprValue>);
		if (where) q.where(where as any);
		return q;
	}

	/**
	 * Called after tooltip table is written. If fitDomain is active, issue a
	 * sidecar MIN/MAX query against the fresh tooltip table.
	 */
	#onTooltipTableWritten(): void {
		const fitDomain = this.#config.fitDomain;
		if (!fitDomain) return;
		if (this.#fitDomainSuppressed) return;

		const fittedAxis = this.#resolveFittedAxis(fitDomain);
		if (!fittedAxis) return;

		const drivingAxis = fittedAxis === 'y' ? 'x' : 'y';
		const drivingSS =
			drivingAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
		if (!drivingSS) return;

		if (drivingSS.scaleType === 'band') {
			this.#issueFitDomainQuery(fittedAxis, null, true);
			return;
		}

		const target = drivingSS.domain?.target;
		if (!target) return;

		this.#issueFitDomainQuery(fittedAxis, target as [number, number], true);
	}

	// ===========================================================================
	// CLEANUP
	// ===========================================================================

	destroy(): void {
		this.#destroyed = true;
		this.#queryEngine.cancel(this.#markId);
		clearTimeout(this.#fitDomainTimeout!);
		clearTimeout(this.#tooltipWriteTimeout!);

		if (this.#adaptiveBinRung) {
			this.#adaptiveBinRung.destroy();
			this.#adaptiveBinRung = null;
		}

		for (const node of this.#rollingAvgNodes.values()) {
			node.clearInvalidation();
		}

		// Drop tooltip temp table
		this.#tooltipTableReady = false;
		if (this.#tooltipWanted) {
			this.#queryEngine.exec(`DROP TABLE IF EXISTS "${this.#tooltipTableName}"`).catch(() => {});
		}

		this.#arrowTable = null;
	}
}
