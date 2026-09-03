/**
 * MarkLifecycleV2 — Svelte-native mark lifecycle with reactive registration.
 *
 * Replaces the 10-effect state machine in MarkLifecycle.svelte.ts by
 * eliminating DataClient, ViewManager, and the Mosaic callback protocol.
 * Uses QueryEngine registration for filter-driven batch re-queries and
 * MarkHandle as the reactive result channel.
 *
 * Phase 1: Setup (one-shot async, one $effect)
 *   Batch all domain queries → register domains → mark scales ready
 *   → setupComplete = true
 *
 * Registration: watches #resolvedQueryParts, registers with engine.
 *   Engine handles filter-driven re-queries via onFilterChange().
 *
 * Params: watches sort/limit/filterNulls on ReactiveConfig.
 *   Changes trigger re-query for this mark only, no teardown.
 */

import { untrack } from 'svelte';
import type { Table } from '@uwdata/flechette';
import {
	Query,
	isNode,
	isAggregateExpression,
	isColumnRef,
	isColumnParam,
	sql,
	column as sqlColumn,
	cast,
	min,
	max,
	isNotNull,
	and
} from '@uwdata/mosaic-sql';
import type { ExprNode, ExprValue, GroupByExpr } from '@uwdata/mosaic-sql';
import type { ScaleRequirement } from '$lib/scales/ScalePriorities';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { ArrowDataAccessor } from '$lib/data/DataAccessor';
import type { DataAccessor } from '$lib/data/DataAccessor';
import type {
	FieldRef,
	NormalizedSortConfig,
	Transform,
	MarkConfig,
	ChartContext,
	ScaleStateInstance,
	ContinuousScaleState
} from '$lib/types';
import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import type { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { SizeScaleState } from '$lib/scales/SizeScaleState.svelte';
import type { QueryEngine } from '$lib/query-engine/QueryEngine';
import { MarkHandle } from '$lib/query-engine/MarkHandle.svelte';
import type { FilterGroup } from '$lib/query-engine/FilterGroup.svelte';
import { isContinuousScale, isNumericScale } from '$lib/scales/scale-categories';
import { buildSchemaMap, type ColumnSchema } from '$lib/query-engine/QueryEngine';
import { type AutoBinNode, isBinExpression } from '$lib/sql/bin';
import { type RollingAvgNode, isRollingAvgExpression } from '$lib/sql/rolling-avg';
import { isWindowExpression } from '$lib/sql/expression-utils';
import { buildCaseExpression } from '$lib/sql/case-expression';
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
	constants?: Record<string, number>;
	colorChannel?: string;
	sizeChannel?: string;
	_orderConfig?: { seriesChannel: string | null; dimensionChannel: string };
	zeroBaseline?: { x?: boolean; y?: boolean };
	passiveScales?: boolean;
	parallelMode?: boolean;
	parallelColumns?: string[];
}

/**
 * ReactiveConfig — per-query and side-concern parameters that don't require
 * lifecycle teardown on change. Object with getters that read through to the
 * mark's reactive state (entry.*).
 */
export interface ReactiveConfig {
	readonly sort: NormalizedSortConfig | undefined;
	readonly limit: number | undefined;
	readonly filterNulls: unknown[] | null | undefined;
	readonly domain: { x?: string[]; y?: string[] } | null | undefined;
	readonly tooltip: boolean | { sortTable?: boolean };
	readonly fitDomain: 'x' | 'y' | boolean | undefined;
	readonly tip: (unknown | '*')[] | false | undefined;
}

// ---------------------------------------------------------------------------
// MarkLifecycleV2
// ---------------------------------------------------------------------------

export class MarkLifecycleV2 {
	// --- Public Reactive State ---
	setupComplete = $state(false);

	// --- Private Properties ---
	#config: MarkLifecycleV2Config;
	#reactiveConfig: ReactiveConfig;
	#queryEngine: QueryEngine;
	#chartContext: ChartContext;
	#markId: string;
	#filterGroup: FilterGroup;
	#scaleMap: Record<string, ScaleStateInstance | null> = {};
	#colorScaleState = $state<ColorScaleState | null>(null);
	#seriesScaleState = $state<ColorScaleState | null>(null);
	#sizeScaleState = $state<SizeScaleState | null>(null);

	// --- Transforms ---
	#transformCompiler: TransformCompiler;
	#transformConfig: MarkConfig;
	#autoBinNodes: Map<string, AutoBinNode> = new Map();
	#rollingAvgNodes: Map<string, RollingAvgNode> = new Map();
	#rollingAvgVersion = $state(0);

	// --- Query State (reactive — feed #resolvedQueryParts $derived) ---
	#fieldStats = $state<Record<string, { column: string; min: number; max: number }> | null>(null);
	#schema = $state<Map<string, ColumnSchema> | null>(null);
	#lastBinDomain = $state<Record<string, [number, number]>>({});
	#adaptiveBinRung: AdaptiveBinRung | null = null;

	// --- Engine Registration ---
	#handle = $state<MarkHandle | null>(null);

	// --- Structural query parts ($derived — recomputes on bin/scale/config changes) ---
	#resolvedQueryParts: QueryParts | null = $derived.by(() => {
		if (!this.setupComplete) return null;

		const resolvedSelect = { ...this.#config.select };

		// Resolve AutoBinNodes — reads #fieldStats ($state), #lastBinDomain ($state),
		// binStepMultiplier (reactive on chartContext)
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

		// Resolve RollingAvgNodes — track invalidation counter
		void this.#rollingAvgVersion;
		for (const [ch, value] of Object.entries(resolvedSelect)) {
			if (isRollingAvgExpression(value)) {
				resolvedSelect[ch] = value.resolve();
			}
		}

		// Capture passthrough channels BEFORE inline wrappings mutate the select.
		// String values and plain ColumnRefNodes are 1:1 with their source column;
		// preagg uses this to fold redundant window col refs into channel aliases.
		const passthroughChannels = new Map<string, string>();
		for (const [ch, val] of Object.entries(resolvedSelect)) {
			if (typeof val === 'string') {
				passthroughChannels.set(ch, val);
			} else if (isNode(val) && isColumnRef(val) && !isColumnParam(val)) {
				passthroughChannels.set(ch, (val as { column: string }).column);
			}
		}

		// Inline CASE expressions — reads scale states reactively
		this.#inlineCaseExpressions(resolvedSelect);
		this.#inlineTimeOffsets(resolvedSelect);

		return buildQueryParts(
			resolvedSelect,
			this.#config._orderConfig ?? null,
			this.#transformCompiler.hasSQLTransforms(),
			passthroughChannels
		);
	});

	// --- Domain State ---
	#channelsNeedingDataDomain: Set<string> = new Set();
	#dataDerivedDomainsSet = $state(false);
	#globalAggregatesSet = $state(false);
	#skipDomainUpdateForAxis: string | null = null;
	#lastBandDomainDataVersion: number | null = null;

	// --- Tooltip ---
	#tooltipTableName: string;
	#tooltipTableReady = $state(false);
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
		reactiveConfig: ReactiveConfig,
		queryEngine: QueryEngine,
		chartContext: ChartContext,
		markId: string,
		filterGroup: FilterGroup,
		options?: { gpuCoordinator?: GPUCoordinator | null; onMarkLOD?: ((surface: any) => void) | null }
	) {
		this.#config = config;
		this.#reactiveConfig = reactiveConfig;
		this.#queryEngine = queryEngine;
		this.#chartContext = chartContext;
		this.#markId = markId;
		this.#filterGroup = filterGroup;

		// Tooltip table name
		this.#tooltipTableName = `_tt_${this.#markId.replace(/-/g, '_')}`;

		// Transform compiler
		// Shared by SQL transforms (query assembly) and JS transforms (data stage).
		// Built once: markType/select/constants are all structural config.
		this.#transformConfig = {
			markType: config.markType,
			table: config.table,
			x: this.#getFieldName('x'),
			y: this.#getFieldName('y'),
			fill: this.#getFieldName('fill')
		};
		this.#transformCompiler = new TransformCompiler(
			config.transforms || [],
			this.#transformConfig
		);
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
					// #lastBinDomain is $state — #resolvedQueryParts recomputes automatically.
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
					this.#rollingAvgVersion++;
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

		// Registration: watches #resolvedQueryParts, registers with engine.
		// Re-registers on structural change (new parts reference).
		// Does NOT fire an initial query — the params effect runs
		// immediately after and triggers the first query via _onParamsChange.
		$effect(() => {
			const parts = this.#resolvedQueryParts;
			if (!parts || !this.setupComplete) return;
			const schema = this.#schema;
			if (!schema) return;

			untrack(() => {
				// registerMark handles cleanup of previous registration for this
				// markId and reuses the existing handle (preserves arrowTable
				// during re-query so the chart doesn't flash empty on rebin).
				this.#handle = this.#queryEngine.registerMark(
					this.#markId,
					{
						table: this.#config.table,
						parts,
						schema,
						transformCompiler: this.#transformCompiler
					},
					this.#filterGroup
				);
			});
		});

		// Push per-mark params and trigger query. Runs immediately after
		// registration (Svelte flushes effects in creation order), providing
		// the initial query. On subsequent changes to sort/limit/filterNulls,
		// re-queries this mark only via _onParamsChange.
		$effect(() => {
			if (!this.#handle) return;
			const sort = this.#reactiveConfig.sort;
			const limit = this.#reactiveConfig.limit;
			const filterNulls = this.#reactiveConfig.filterNulls;
			untrack(() => {
				this.#handle!.updateParams({ sort, limit, filterNulls });
			});
		});

		// Domain registration: when data arrives, register data-derived domains.
		$effect(() => {
			if (!this.setupComplete) return;
			const dv = this.dataVersion;
			if (dv === 0) return;

			untrack(() => {
				this.#handleDataDomains(dv);
			});
		});

		// Band re-sort: lightweight re-sort when sort config changes.
		// Fires a targeted domain query — no teardown, no schema re-fetch.
		$effect(() => {
			if (!this.setupComplete) return;
			const sort = this.#reactiveConfig.sort;

			untrack(() => {
				for (const [axis, scaleType] of [
					['x', this.actualXScaleType],
					['y', this.actualYScaleType]
				] as const) {
					if (scaleType !== 'band' && scaleType !== 'point') continue;
					const scaleState = this.#scaleMap[axis] as BandScaleState | null;
					if (!scaleState) continue;
					this.#refetchSortedDomain(axis, scaleState, sort);
				}
			});
		});

		// Tooltip: write tooltip table when data updates (debounced).
		$effect(() => {
			const tooltipConfig = this.#reactiveConfig.tooltip;
			const fitDomain = this.#reactiveConfig.fitDomain;
			const tooltipWanted = tooltipConfig !== false || !!fitDomain;
			if (!tooltipWanted) return;

			const dataVersion = this.dataVersion;
			if (dataVersion === 0) return;

			untrack(() => {
				clearTimeout(this.#tooltipWriteTimeout!);
				this.#tooltipWriteTimeout = setTimeout(() => {
					const data = this.data;
					if (data && data.length > 0) this.#writeTooltipTable(data);
				}, 300);
			});

			// Cleanup: when tooltip goes true→false, drop the temp table.
			return () => {
				clearTimeout(this.#tooltipWriteTimeout!);
				this.#tooltipTableReady = false;
				this.#queryEngine
					.exec(`DROP TABLE IF EXISTS "${this.#tooltipTableName}"`)
					.catch(() => {});
			};
		});

		// fitDomain — query DuckDB for fitted axis extent on driving axis change.
		$effect(() => {
			const fitDomain = this.#reactiveConfig.fitDomain;
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

		// Passive scales: skip domain fetching but still need schema for CAST decisions
		if (this.#config.passiveScales) {
			this.#schema = buildSchemaMap(
				await this.#queryEngine.describe(this.#config.table)
			);
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
					this.#reactiveConfig.sort,
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
					this.#reactiveConfig.domain
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

			// Setting #fieldStats and #schema via $state triggers #resolvedQueryParts
			// recomputation, which then triggers the registration effect.
			this.setupComplete = true;
		} catch (error) {
			if ((error as Error)?.name === 'AbortError') return;
			console.error(`[MarkLifecycleV2] Setup failed for ${this.#markId}:`, error);
		}
	}

	// ===========================================================================
	// QUERY HELPERS
	// ===========================================================================

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

		// Facet cell index. The renderers compile a faceted pipeline whenever
		// chartContext.fx is set and discard instances whose __facet differs
		// from the active cell, so the column has to be in the select or the
		// facet vertex buffer is never written. V1 set this from ViewManager's
		// index column; V2 dropped it in the migration.
		if (this.#chartContext.fx) {
			const facetScale = this.#chartContext.facetBandScale as BandScaleState | null;
			if (facetScale?.caseExpression) {
				select.__facet = sql`${facetScale.caseExpression}`;
			}
		}
	}

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

	/**
	 * Register data-derived domains after query results arrive.
	 * Called from the domain registration effect when dataVersion changes.
	 */
	#handleDataDomains(dv: number): void {
		const arrowTable = this.#handle?.arrowTable;
		if (!arrowTable || arrowTable.numRows === 0) return;
		if (this.#config.passiveScales) return;

		// Once domains are derived from the first query result, skip
		// re-registration on subsequent results (e.g., crossfilter updates).
		// Exception: topN marks need band domain re-derivation on new data.
		if (this.#dataDerivedDomainsSet) {
			if (
				this.#transformCompiler.hasCategoryReducingTransforms() &&
				dv !== this.#lastBandDomainDataVersion
			) {
				this.#lastBandDomainDataVersion = dv;
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

			markDeferredScalesReady(
				this.#scaleMap,
				this.#channelsNeedingDataDomain,
				this.actualXScaleType,
				this.actualYScaleType
			);
		}
	}

	/**
	 * Re-fetch band domain ordering when sort config changes reactively.
	 * Builds a SELECT DISTINCT + ORDER BY query, calls setSortOrder on the
	 * band scale. No teardown, no schema re-fetch, no re-registration.
	 */
	async #refetchSortedDomain(
		axis: string,
		scaleState: BandScaleState,
		sort: NormalizedSortConfig | undefined
	): Promise<void> {
		const field = this.#config.select[axis];
		if (!field) return;

		// KNOWN BUG: assumes `field` is a plain column name / ColumnRefNode.
		// A band/point axis backed by a computed expression (e.g. y={bin(...)}
		// on a BarMarkX, binning the mark's categorical axis) hits
		// sqlColumn(String(field)) below, stringifying the expression object
		// to "[object Object]" and producing an invalid query. Pre-existing,
		// unrelated to the SQL normalize/topN transform work — filed for a
		// separate fix. Repro: /test/transforms, BarMarkX with
		// y={bin('body_mass', {step:500})}.
		let q = Query.from(this.#config.table)
			.select({ [axis]: sqlColumn(String(field)) });

		if (sort) {
			const sortField = this.#config.select[sort.channel]
				|| this.#config.select[sort.channel + '2']
				|| this.#config.select[sort.channel + '1'];
			if (!sortField) return;

			if (isAggregateExpression(sortField as ExprNode)) {
				q = q.groupby(field as GroupByExpr)
					.select({ _sort: sortField as ExprValue });
			}
			const sortExpr = isAggregateExpression(sortField as ExprNode)
				? sqlColumn('_sort')
				: isNode(sortField) ? sortField : sqlColumn(String(sortField));

			q.orderby(sort.direction === 'desc'
				? sql`${sortExpr} DESC`
				: sortExpr);
		} else {
			q.distinct();
		}

		try {
			const result = await this.#queryEngine.query(q);
			if (this.#destroyed) return;

			const categories = Array.from(result).map((row: any) => row[axis]);
			if (axis === 'y' && sort) categories.reverse();

			if (categories.length > 0) {
				scaleState.setSortOrder(categories);
			}
		} catch (e) {
			if ((e as Error)?.name === 'AbortError') return;
			console.warn(`[MarkLifecycleV2] Sort domain fetch failed:`, e);
		}
	}

	/**
	 * Build a query for fetchGlobalAggregates.
	 * Standalone assembly — doesn't depend on #resolvedQueryParts
	 * (which isn't available yet during Phase 1 setup).
	 */
	#buildQueryForAggregates(
		_table: string,
		_config: any,
		filter: unknown[]
	): Query | null {
		// Build raw query parts directly from config.select (no CASE inlining,
		// no bin resolution — scale states aren't ready yet during Phase 1).
		const parts = buildQueryParts(
			this.#config.select,
			this.#config._orderConfig ?? null,
			this.#transformCompiler.hasSQLTransforms()
		);
		const q = assembleQuery({
			table: this.#config.table,
			parts,
			filter,
			filterNulls: this.#reactiveConfig.filterNulls ?? null,
			transformCompiler: this.#transformCompiler
		});
		if (!q) return null;
		return Query.from(sql`(${q.toString()})` as any).select('*');
	}

	// ===========================================================================
	// PUBLIC API (consumed by mark components)
	// ===========================================================================

	/**
	 * Build a viewport count query for DensityHost LOD measurement.
	 * Wraps the mark's assembled query as a subquery and counts rows within
	 * the given viewport bounds. Returns null before setup completes (scale
	 * domains and time offsets aren't available yet).
	 */
	buildViewportCountQuery(
		xLo: number,
		xHi: number,
		yLo: number,
		yHi: number
	): string | null {
		if (!this.setupComplete || !this.#resolvedQueryParts) return null;

		const filter = this.#filterGroup.selection.predicate(this.#markId) ?? [];
		const q = assembleQuery({
			table: this.#config.table,
			parts: this.#resolvedQueryParts,
			filter: filter as unknown[],
			filterNulls: this.#reactiveConfig.filterNulls ?? null,
			transformCompiler: this.#transformCompiler,
			limit: this.#reactiveConfig.limit
		});
		if (!q) return null;
		const sqlStr = q.toString();

		const parts: string[] = [`SELECT COUNT(*) AS cnt FROM (${sqlStr}) AS _vp`];
		const conditions: string[] = [`_vp.x BETWEEN ${xLo} AND ${xHi}`];
		if (isFinite(yLo) && isFinite(yHi)) {
			conditions.push(`_vp.y BETWEEN ${yLo} AND ${yHi}`);
		}
		parts.push(`WHERE ${conditions.join(' AND ')}`);
		return parts.join(' ');
	}

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
		return this.#reactiveConfig.tooltip !== false && this.#tooltipTableReady;
	}

	get channelFieldMap(): Record<string, string> {
		return buildChannelFieldMap(this.#config.select);
	}

	get dataVersion(): number {
		return this.#handle?.dataVersion ?? 0;
	}

	get hasCategoryReducingTransforms(): boolean {
		return this.#transformCompiler.hasCategoryReducingTransforms();
	}

	// Processed data with JS transforms applied — reads from MarkHandle
	data: DataAccessor | null = $derived.by(() => {
		const arrow = this.#handle?.arrowTable;
		if (!arrow) return null;

		// No aliasMap needed — with forMosaic=false, the query SELECT uses
		// channel names as aliases, so Arrow column names are already x, y, fill, etc.
		let accessor: DataAccessor = new ArrowDataAccessor(arrow);

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

		return this.#transformCompiler.applyToData(accessor, this.#transformConfig, {
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
				// in distance math). A band/point axis stays un-CASE-inlined (real
				// category strings, not an ordinal index) in the main query when a
				// category-reducing transform like topN is present
				// (#inlineCaseExpressions' skipBandIndex — the top-N set can
				// change, so a static CASE baked into that query would go stale).
				// But TooltipManager's hit-test universally assumes band axes hold
				// the scale's ordinal index (CAST(col AS INTEGER) = hoveredIndex),
				// same as every other band-axis mark — so CASE-inline it here
				// instead, safe because by tooltip-write time the domain is
				// already resolved from the actual (post-transform) results.
				const selectConfig = this.#config.select;
				const resolvedSelect = this.#resolvedQueryParts?.selectDef ?? {};
				const schema = this.#schema;
				const xScaleState = this.#chartContext.xScaleState as BandScaleState | null;
				const yScaleState = this.#chartContext.yScaleState as BandScaleState | null;
				const replaceExprs: string[] = [];
				for (const c of ['x', 'x1', 'x2', 'y', 'y1', 'y2'] as const) {
					if (!(c in selectConfig)) continue;
					const expr = resolvedSelect[c];
					const isRawColumnRef =
						expr != null && isColumnRef(expr as ExprNode) && !isColumnParam(expr as ExprNode);
					const jsType = isRawColumnRef
						? schema?.get((expr as { column: string }).column)?.jsType
						: undefined;

					if (isRawColumnRef && jsType && jsType !== 'number') {
						const axis = c.startsWith('x') ? 'x' : 'y';
						const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
						const scaleState = axis === 'x' ? xScaleState : yScaleState;
						if ((scaleType === 'band' || scaleType === 'point') && scaleState?.effectiveDomain?.length) {
							replaceExprs.push(`${buildCaseExpression(c, scaleState.effectiveDomain)} AS ${c}`);
						}
						// Else: unexpected non-numeric, non-band column — leave as-is.
						continue;
					}
					replaceExprs.push(`CAST(${c} AS DOUBLE) AS ${c}`);
				}
				const replaceClause = replaceExprs.length > 0 ? ` REPLACE (${replaceExprs.join(', ')})` : '';

				// Optional ORDER BY for zone-map skipping in bounding-box queries.
				let orderClause = '';
				const tooltipSortTable = typeof this.#reactiveConfig.tooltip === 'object'
					? this.#reactiveConfig.tooltip.sortTable !== false : true;
				if (tooltipSortTable) {
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
		if (!this.#resolvedQueryParts) return null;
		const filter = this.#filterGroup.selection.predicate(this.#markId) ?? [];

		const q = assembleQuery({
			table: this.#config.table,
			parts: this.#resolvedQueryParts,
			filter: filter as unknown[],
			filterNulls: this.#reactiveConfig.filterNulls ?? null,
			transformCompiler: this.#transformCompiler,
			limit: this.#reactiveConfig.limit
		});
		if (!q) return null;
		return q.toString();
	}

	/** Extract expression nodes from the tip prop as { label: exprNode } pairs. */
	#getTipExtras(): Record<string, unknown> {
		const extras: Record<string, unknown> = {};
		const tipEntries = this.#reactiveConfig.tip;
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
		if (!this.#resolvedQueryParts) return;

		// Identify non-aggregate channel columns — these are the join keys
		const joinCols: string[] = [];
		for (const [ch, expr] of Object.entries(this.#resolvedQueryParts.selectDef)) {
			if (!isAggregateExpression(expr as any) && !isWindowExpression(expr as any)) {
				joinCols.push(ch);
			}
		}

		// Build sidecar select: group-by columns + tip extras
		const sidecarSelect: Record<string, unknown> = {};
		for (const ch of joinCols) {
			sidecarSelect[ch] = this.#resolvedQueryParts.selectDef[ch];
		}
		Object.assign(sidecarSelect, tipExtras);

		const sidecarParts = buildQueryParts(
			sidecarSelect,
			undefined,
			this.#transformCompiler.hasSQLTransforms()
		);

		const filter = this.#filterGroup.selection.predicate(this.#markId) ?? [];
		const sidecarQuery = assembleQuery({
			table: this.#config.table,
			parts: sidecarParts,
			filter: filter as unknown[],
			filterNulls: this.#reactiveConfig.filterNulls ?? null,
			transformCompiler: this.#transformCompiler
		});
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
				callerId: `${this.#markId}:fitDomain`,
				cache: false
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
		// Whether to include transform-generated channels (stack's y0/y1) — tied
		// to the transform actually adding channels, not to which query path
		// (tooltip table vs. sidecar-wrapped query) supplies them. A SQL-stage
		// stack has no tooltip table but #buildSidecarQuery still re-assembles
		// the full query (transforms included), so y0/y1 are there either way.
		const includeTransformChannels = this.#transformCompiler.getAdditionalChannels().length > 0;

		const fittedChannels = this.#getFitDomainChannels(fittedAxis, includeTransformChannels);
		if (fittedChannels.length === 0) return null;

		const outerSelect: Record<string, unknown> = {};
		for (const ch of fittedChannels) {
			outerSelect[`min_${ch}`] = min(sqlColumn(ch));
			outerSelect[`max_${ch}`] = max(sqlColumn(ch));
		}

		let whereClause: unknown = undefined;
		if (drivingDomain) {
			const drivingAxis = fittedAxis === 'y' ? 'x' : 'y';
			const drivingChannels = this.#getFitDomainChannels(drivingAxis, includeTransformChannels);
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
		const fitDomain = this.#reactiveConfig.fitDomain;
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
		this.#handle?.destroy();
		clearTimeout(this.#fitDomainTimeout!);
		clearTimeout(this.#tooltipWriteTimeout!);

		if (this.#adaptiveBinRung) {
			this.#adaptiveBinRung.destroy();
			this.#adaptiveBinRung = null;
		}

		for (const node of this.#rollingAvgNodes.values()) {
			node.clearInvalidation();
		}

		// Defensive tooltip table cleanup. The tooltip $effect cleanup
		// also drops the table on unmount. This explicit DROP covers the case
		// where destroy() is called synchronously before Svelte processes
		// effect teardown.
		this.#tooltipTableReady = false;
		this.#queryEngine.exec(`DROP TABLE IF EXISTS "${this.#tooltipTableName}"`).catch(() => {});
	}
}
