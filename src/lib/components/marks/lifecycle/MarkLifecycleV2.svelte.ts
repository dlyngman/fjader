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
import { withDenseCategories } from '$lib/transforms';
import { ArrowDataAccessor } from '$lib/data/DataAccessor';
import type { DataAccessor } from '$lib/data/DataAccessor';
import type {
	FieldRef,
	NormalizedSortConfig,
	Transform,
	ChannelIdentity,
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
import { isRollingAvgExpression } from '$lib/sql/rolling-avg';
import { isWindowExpression } from '$lib/sql/expression-utils';
import { identityKeyFor } from '$lib/query-engine/identity-key';
import { AdaptiveBinRung } from '$lib/lod/AdaptiveBinRung.svelte';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import { generateMarkId, buildChannelFieldMap } from '../utils';
import { buildExpressionLabel, isLabeledTipEntry } from '../utils/channel-field-map';
import { detectChannelsNeedingDataDomain } from './domain-computation';
import { buildQueryParts, assembleQuery, castReal, type QueryParts } from './query-builder';
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
	/**
	 * Return a row for every category on a categorical axis, not only the ones
	 * that survived the filter. Default on.
	 *
	 * Set false to opt out. The cost it buys back is a result sized by the
	 * dimension rather than by what is displayed, which matters at high
	 * cardinality; what it gives up is a category being able to fade out rather
	 * than disappear, and the row alignment that lets values morph at all.
	 */
	dense?: boolean;
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
	/**
	 * Categorical fields with an id column in this table's view. Only these may
	 * be selected as identity ids; a positional axis that is not here has no
	 * fallback and does not render (see #ensureIdentityColumns).
	 *
	 * Cleared by #onIdentityReset, because after a reload the columns it names
	 * no longer exist — and #sourceTable and #inlineIdentityColumns both gate on
	 * it being non-empty.
	 */
	#identityFields: Set<string> = new Set();
	/** Unsubscribe from the engine's identity resets. */
	#identityResetOff: (() => void) | null = null;

	/**
	 * The relation any query built from #resolvedQueryParts must read.
	 *
	 * Those parts can carry identity id columns, which exist only on the view.
	 * Degrades to the bare table when THIS mark requested no identity columns,
	 * so a chart with no categorical axis is untouched. Safe for every query
	 * shape because the view is `SELECT t.*` plus the id columns — anything
	 * valid against the table is valid against the view.
	 *
	 * Gated on this mark's own #identityFields, NOT on whether a view exists for
	 * the table. The engine's registry is per TABLE and is populated
	 * synchronously when any mark calls ensureColumns, so asking it directly
	 * hands the view's name to sibling marks that never requested identity and
	 * therefore never awaited the CREATE — they then query a relation that does
	 * not exist yet (`Catalog Error: Table with name <table>_v_s<session> does
	 * not exist`). Two marks on one table where only one has a band axis is an
	 * ordinary chart, not a corner case: see /examples/brush-demo.
	 *
	 * #identityFields is filled only after ensureColumns resolves, so a non-empty
	 * set also means the view is built — this is the timing guarantee as well as
	 * the scoping one.
	 *
	 * Not used by #buildQueryForAggregates, which runs in Phase 1 setup from the
	 * raw config select before scales are ready, so it never names an id column.
	 */
	get #sourceTable(): string {
		if (this.#identityFields.size === 0) return this.#config.table;
		return this.#queryEngine.identitySourceFor(this.#config.table);
	}
	/**
	 * Every channel of this mark carrying category ids, and its dim — null until
	 * identity setup, and again after a reset. Set only through #setIdentity,
	 * which mirrors it onto #transformConfig for the transforms.
	 *
	 * Reactive because the query parts depend on it and it arrives after the
	 * first build. Without that the FIRST query is built without it: no ORDER BY,
	 * so its rows come back in whatever order the aggregation produced, and the
	 * next query — built with it — in id order. Two results in two orders is
	 * precisely the misalignment the ordering exists to prevent.
	 */
	#identity: Record<string, ChannelIdentity> | null = $state.raw(null);

	// --- Query State (reactive — feed #resolvedQueryParts $derived) ---
	#fieldStats = $state<Record<string, { column: string; min: number; max: number }> | null>(null);
	#schema = $state<Map<string, ColumnSchema> | null>(null);
	#lastBinDomain = $state<Record<string, [number, number]>>({});
	#adaptiveBinRung: AdaptiveBinRung | null = null;

	// --- Engine Registration ---
	#handle = $state<MarkHandle | null>(null);

	// --- Semantic select ($derived — recomputes on bin/config changes) ---
	//
	// Channel expressions with their *meaning* resolved — an AutoBinNode becomes a
	// concrete bin expression, a RollingAvgNode becomes a window function — but not
	// yet encoded for the GPU.
	//
	// Split out of #resolvedQueryParts because #refetchSortedDomain needs exactly this
	// form. It selects category *values*, so it must see resolved bins but must not
	// see #inlineIdentityColumns below, which swaps a categorical channel for its
	// dim's id column.
	#resolvedSelect: Record<string, unknown> | null = $derived.by(() => {
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

		// Identity setup changes what this resolves to downstream; see the field.
		void this.#identity;
		for (const [ch, value] of Object.entries(resolvedSelect)) {
			if (isRollingAvgExpression(value)) {
				resolvedSelect[ch] = value.resolve();
			}
		}

		return resolvedSelect;
	});

	// --- Structural query parts ($derived — recomputes on bin/scale/config changes) ---
	#resolvedQueryParts: QueryParts | null = $derived.by(() => {
		const semanticSelect = this.#resolvedSelect;
		if (!semanticSelect) return null;

		// Copy before the inline helpers below, which mutate in place — #resolvedSelect
		// is shared with #refetchSortedDomain and must not carry GPU encodings.
		const resolvedSelect = { ...semanticSelect };

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
		this.#inlineIdentityColumns(resolvedSelect);
		this.#inlineTimeOffsets(resolvedSelect);

		const parts = buildQueryParts(
			resolvedSelect,
			this.#config._orderConfig ?? null,
			this.#transformCompiler.hasSQLTransforms(),
			passthroughChannels
		);

		return parts;
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
		options?: {
			gpuCoordinator?: GPUCoordinator | null;
			onMarkLOD?: ((surface: any) => void) | null;
		}
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
		// `dense()` is added here rather than in each of the twelve mark components
		// that assemble transform lists, and it is added unconditionally: it
		// refuses itself at apply time unless the mark has exactly one dimmed
		// categorical axis that is also a GROUP BY key. That keeps the condition
		// in one place, next to the reason for it, instead of spread across the
		// callers that would each have to re-derive it.
		//
		// `dense: false` on the mark opts out.
		this.#transformCompiler = new TransformCompiler(
			withDenseCategories(config.transforms || [], config.dense !== false),
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

		// A data reload drops the identity dims and views out from under this
		// mark's query parts. Subscribed here rather than in an effect: it has to
		// outlive setupComplete flipping, which is exactly what it manipulates.
		this.#identityResetOff = this.#queryEngine.onIdentityReset(() => this.#onIdentityReset());

		// Start reactive effects
		this.#setupReactiveEffects();
	}

	/**
	 * The engine dropped every identity dim and view (a data reload).
	 *
	 * Everything this mark holds from before the reset is invalid: the id
	 * columns its query selects are gone with the view, and any id already in a
	 * vertex buffer belongs to a numbering that no longer exists. Rather than
	 * patch that up, hand the whole thing back to Phase 1 — clearing
	 * setupComplete re-arms the setup effect, which re-runs #ensureIdentityColumns
	 * and rebuilds the dims against the reloaded data.
	 *
	 * Clearing setupComplete also stops the bleeding immediately: #resolvedSelect
	 * returns null without it, so #resolvedQueryParts goes null and the
	 * registration effect stops re-registering. The mark's EXISTING registration
	 * survives the gap, so a filter change landing in the few milliseconds before
	 * setup completes can still assemble one query from the stale descriptor;
	 * that query fails and is swallowed by the same handler that covers table
	 * recreation. Tearing the handle down instead would flash every chart empty
	 * on every reload, which registerMark goes out of its way to avoid.
	 */
	#onIdentityReset(): void {
		if (this.#destroyed) return;
		this.#identityFields.clear();
		// Every dim it names just went away — topN must not bucket into one.
		this.#setIdentity(null);
		this.setupComplete = false;
	}

	// ===========================================================================
	// CONSTRUCTOR HELPERS
	// ===========================================================================

	#detectAutoBins(): void {
		for (const [channel, value] of Object.entries(this.#config.select)) {
			if (isBinExpression(value)) {
				this.#autoBinNodes.set(channel, value);
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

			// Read #colorScaleState REACTIVELY — outside the untrack below — so
			// that attaching it re-enters this effect. #runSetup returns without
			// completing while this is false, which is the only reason the
			// re-entry has anything to do. See there.
			//
			// Colour only, despite what this comment used to say about "color/
			// series": #seriesScaleState is not read here and so is not tracked.
			// That is currently harmless because the series channel never takes a
			// dim — it is passed to fetchCategoricalDomains and nowhere else — but
			// it is not a guarantee anyone wrote down.
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
						table: this.#sourceTable,
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
		// or to a transform parameter given as a getter, re-queries this mark
		// only via _onParamsChange.
		$effect(() => {
			if (!this.#handle) return;
			const sort = this.#reactiveConfig.sort;
			const limit = this.#reactiveConfig.limit;
			const filterNulls = this.#reactiveConfig.filterNulls;
			// Read for tracking only: transforms read their parameters when the query
			// is assembled, so a changed count needs a re-query and not a rebuild.
			void this.#transformCompiler.specs;
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
				this.#queryEngine.exec(`DROP TABLE IF EXISTS "${this.#tooltipTableName}"`).catch(() => {});
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

		// Wait for the colour scale before completing setup.
		//
		// `colorReady` was computed and passed here from the moment this effect
		// was written, and never read — so the deferral it describes did not
		// happen, and whether a mark got colour identity came down to timing.
		//
		// The ordering is not a race that usually goes the right way; it CANNOT
		// go the right way on the first pass. MarkColor attaches the scale from
		// an $effect that requires `setup` to already exist
		// (MarkColor.svelte.ts:123), so `#colorScaleState` is necessarily null
		// when this runs for the first time. What saved most marks is the
		// `scalesAvailable` gate above: they wait for BOTH x and y scale states,
		// and MarkColor's effect lands in the gap. A parallel mark waits for x
		// alone, reaches this one scale-resolution earlier, and completes setup
		// with no colour scale — after which `if (this.setupComplete) return;`
		// blocks the re-entry the comment there promises.
		//
		// The consequence was silent and specific: #ensureIdentityColumns saw no
		// colour key, so the field was never dimmed and #identityFields never
		// got it, and #inlineIdentityColumns — which gates on that Set — could
		// never swap the id column in, however many times it re-derived. On a
		// page where another mark dimmed the same field, the SHARED colour scale
		// ended up with identity while this mark's query still selected raw
		// strings, which is the error ColorScaleState.processDataForGPU raises.
		//
		// Returning WITHOUT setting setupComplete is the whole mechanism: the
		// effect reads #colorScaleState reactively, so attaching it re-enters
		// here. A mark with no colour channel is ready by definition — that is
		// the `!select[colorKey]` half of the expression — so this cannot stall
		// a chart that was never going to get a colour scale.
		if (!colorReady) return;

		// Passive scales: skip domain fetching but still need schema for CAST decisions
		if (this.#config.passiveScales) {
			this.#schema = buildSchemaMap(await this.#queryEngine.describe(this.#config.table));
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
				this.#fetchFieldStats(),
				this.#ensureIdentityColumns()
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
	 * Encode the categorical channels into the SELECT, replacing ViewManager's
	 * view columns with direct SQL.
	 *
	 * One encoding now, and the name is the older one: every categorical channel
	 * — band and point x and y, the facet grid, ordinal colour — takes the
	 * view's identity id column. The CASE this is named after is deleted.
	 */
	#inlineIdentityColumns(select: Record<string, unknown>): void {
		// Band/point x and y: always the view's identity id column, never a CASE.
		//
		// The CASE this replaced was built from the scale's DOMAIN, so the query
		// text depended on display order and a reorder invalidated preagg cubes
		// and cache entries. It also had to be suppressed whenever a
		// category-reducing transform was present, because a domain holding only
		// the survivors maps everything else to -1 before the transform runs —
		// that was `skipBandIndex`, and it is gone with the CASE. Ids come from
		// the dim, are independent of which categories survive, and topN filters
		// them as integers.
		//
		// An axis with no identity is one #identityKey refused: bin(), or an
		// aggregate. #ensureIdentityColumns reports it; there is no fallback to
		// fall into, which is the point.
		for (const axis of ['x', 'y'] as const) {
			const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
			if (scaleType !== 'band' && scaleType !== 'point') continue;

			// The same derivation #ensureIdentityColumns registered under, so a
			// dimmed expression axis selects its id column like a dimmed column.
			const key = this.#identityKey(axis)?.key;
			if (key == null || !this.#identityFields.has(key)) continue;

			// CAST to REAL explicitly. processDataForGPU's zero-copy path keys on
			// Float32Array, and castNumeric cannot help: it casts a column ref only
			// when the schema says the column is numeric, and the schema comes from
			// DESCRIBE of the BASE table, which has no __dplot_*_idx columns. An INT
			// column would arrive as an Int32Array and miss the fast path.
			select[axis] = castReal(sqlColumn(this.#queryEngine.identityColumn(key)));
		}

		// Ordinal colour. The id column, like every other categorical channel —
		// the fragment shader resolves it to this scale's palette rank through
		// the shared slot table, so display order never reaches the query text.
		//
		// No CASE fallback, and nothing lost by that. A field this cannot dim is
		// an aggregate, a window or a bin, and none of those produced a working
		// ordinal colour scale anyway: the domain fetch skips aggregates
		// entirely, so there was no domain, no palette upload, and paletteSize 0
		// against a `% paletteSize` in the shader. bin() reached the domain query
		// as "[object Object]". The fallback was unreachable for exactly the
		// cases it appeared to cover.
		const colorChannel = this.#config.colorChannel || 'fill';
		const colorField = this.#colorScaleState?.isOrdinal
			? identityKeyFor(this.#config.select[colorChannel])?.key
			: null;
		if (colorField && this.#identityFields.has(colorField)) {
			select[colorChannel] = castReal(sqlColumn(this.#queryEngine.identityColumn(colorField)));
		}

		// Facet. The renderers compile a faceted pipeline whenever chartContext.fx
		// is set and discard instances whose __facet differs from the cell's
		// value, so the column has to be in the select or the facet vertex buffer
		// is never written.
		//
		// Carries the dim ID, not the cell index — the same move the positional
		// channels made. The comparison still works because GPUCoordinator now
		// resolves the frame uniform through idAtSlot, so both sides are ids.
		// That is what takes display order out of the query text: a facet reorder
		// changes which id sits in which cell and rewrites nothing.
		const facetKey = this.#chartContext.fx ? identityKeyFor(this.#chartContext.fx)?.key : null;
		if (facetKey && this.#identityFields.has(facetKey)) {
			select.__facet = castReal(sqlColumn(this.#queryEngine.identityColumn(facetKey)));
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
	async #fetchFieldStats(): Promise<Record<
		string,
		{ column: string; min: number; max: number }
	> | null> {
		const select = this.#config.select;
		const fields: { key: string; expr: unknown }[] = [];

		// Iterate scaleMap — it has exactly the channels that need domains:
		// x/y for normal marks, plus each parallel column for parallel mode.
		for (const alias of Object.keys(this.#scaleMap)) {
			if (!this.#scaleMap[alias]) continue;
			const scaleType =
				alias === 'x' ? this.actualXScaleType : alias === 'y' ? this.actualYScaleType : 'linear'; // parallel columns are always linear

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
			const colExpr = isNode(unique[i].expr) ? unique[i].expr : sqlColumn(String(unique[i].expr));
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
	 * The identity key for a categorical axis, or null when it cannot be dimmed.
	 *
	 * The key is the source column name, or an expression's SQL text — the same
	 * string `requestScale` puts in `columnName` and therefore the scale's
	 * `sourceField`. Deriving both from one place is what stops scale
	 * identity and dim identity from diverging.
	 *
	 * Refused: bin() (values move with the viewport), and aggregate or
	 * window expressions, which are not a row-level value to group by.
	 */
	#identityKey(axis: 'x' | 'y'): { key: string; sql: string } | null {
		const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
		if (scaleType !== 'band' && scaleType !== 'point') return null;
		return identityKeyFor(this.#config.select[axis]);
	}

	/**
	 * Request identity id columns for this mark's categorical axes (band step 3a).
	 *
	 * Runs inside the setup Promise.all, so every mark on a chart calls it in the
	 * same tick — which is what CategoricalIdentity's coalescer is built for: they
	 * union into one CREATE OR REPLACE VIEW rather than one per mark. Also re-run
	 * after an identity reset, which is a reload rebuilding the dims from scratch.
	 *
	 * Plain columns and fixed SQL expressions both get a dim (#197). They
	 * are not two paths: #identityKey hands over a key and the SQL producing the
	 * value, and CategoricalIdentity substitutes the latter into the same
	 * templates either way. What #identityKey refuses is bin(), aggregates and
	 * window expressions — see there for why — and a refusal is reported below
	 * rather than falling back, because since `b7292b2` there is nothing to fall
	 * back to: the CASE path for positional band channels is deleted.
	 *
	 * Reads every categorical channel, not only the positional axes: the two
	 * band/point axes, then the facet key and the ordinal colour key below. They
	 * are registered in ONE call so they share a single coalesced CREATE OR
	 * REPLACE VIEW rather than triggering one rebuild each.
	 *
	 * These columns ARE consumed: #inlineIdentityColumns selects the id column for
	 * any axis in #identityFields, and the scale keeps ids as its internal
	 * representation. Failing here is therefore fatal, not additive — which is
	 * why the await below is unguarded.
	 */
	async #ensureIdentityColumns(): Promise<void> {
		const axes: { axis: 'x' | 'y'; key: string; sql: string }[] = [];
		for (const axis of ['x', 'y'] as const) {
			const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
			if (scaleType !== 'band' && scaleType !== 'point') continue;

			const resolved = this.#identityKey(axis);
			if (resolved) {
				axes.push({ axis, ...resolved });
				continue;
			}
			// A categorical axis this cannot dim. There is no CASE fallback any
			// more, so it draws nothing — say why rather than
			// leaving an empty chart to be diagnosed.
			console.error(
				`[${this.#markId}] The ${axis} axis is categorical but cannot be given a stable ` +
					`identity: bin() produces values that move with the viewport, and an aggregate ` +
					`or window expression is not a row-level value to group by. Use a rect mark for ` +
					`binned axes. This mark will render nothing on ${axis}.`
			);
		}
		// The two non-axis categorical channels. Neither has a scale type on x or
		// y, but both are categorical over the same table and want the same dim,
		// and both are registered HERE rather than in their own pass so they join
		// the coalesced CREATE OR REPLACE VIEW the axes already trigger.

		// Ordinal colour. Continuous colour has no categories and wants no dim,
		// so this gates on isOrdinal rather than on the channel existing.
		const colorChannel = this.#config.colorChannel || 'fill';
		const colorKey = this.#colorScaleState?.isOrdinal
			? identityKeyFor(this.#config.select[colorChannel])
			: null;

		// Facet. `fx` is a column name or a fixed expression, so it goes through
		// the same derivation as everything else.
		const facetKey = this.#chartContext.fx ? identityKeyFor(this.#chartContext.fx) : null;
		if (this.#colorScaleState?.isOrdinal && this.#config.select[colorChannel] && !colorKey) {
			console.error(
				`[${this.#markId}] The colour channel is categorical but cannot be given a stable ` +
					`identity. Colouring by an aggregate, a window expression or bin() has no ` +
					`categories to colour BY — use a continuous scheme for a computed value. This ` +
					`mark will render without colour.`
			);
		}

		if (this.#chartContext.fx && !facetKey) {
			console.error(
				`[${this.#markId}] fx is set but cannot be given a stable identity, so this mark ` +
					`will render nothing. Facet by a column or a fixed expression.`
			);
		}

		if (axes.length === 0 && !facetKey && !colorKey) return;

		const categorical = [...axes.map(({ key, sql }) => ({ key, sql }))];
		for (const extra of [facetKey, colorKey]) {
			if (extra && !categorical.some((c) => c.key === extra.key)) categorical.push(extra);
		}

		// Fatal, unlike at C0: the query now selects these columns and reads FROM
		// the view. Failing here gives a message naming the mark and the fields;
		// continuing would fail at the binder with neither.
		await this.#queryEngine.ensureColumns(this.#config.table, { categorical });
		for (const { key } of categorical) this.#identityFields.add(key);

		// Tell the transforms which dim each categorical channel is identified by.
		//
		// This is what turns on the dense join: with a dim to join against, a
		// category that drops out of the top N keeps a row at zero instead of
		// vanishing, so its bar can shrink out rather than disappear on the frame
		// the reorder lands. Positional axes are what can be the band. Colour and
		// facet are there too, because densifying needs to know a channel carries
		// ids: one sharing the band's dim is filled from the dim, one from another
		// field takes the absent sentinel.
		//
		// Handed over rather than derived in the transform: the dim name is
		// session-suffixed and owned by the identity coordinator, and a transform
		// rebuilding it from a field name is two derivations that must agree and
		// eventually will not. Sizes are read now; a later Other reservation adds
		// one id, which does not move a row limit that coarse.
		const identity: Record<string, ChannelIdentity> = {};
		const describe = (channel: string, key: string, positional: boolean) => {
			identity[channel] = {
				dim: this.#queryEngine.dimTableFor(key),
				size: this.#queryEngine.identityFor(key).values.length,
				positional
			};
		};
		for (const { axis, key } of axes) describe(axis, key, true);
		if (colorKey && this.#identityFields.has(colorKey.key)) {
			describe(this.#config.colorChannel || 'fill', colorKey.key, false);
		}
		if (facetKey && this.#identityFields.has(facetKey.key)) {
			describe('__facet', facetKey.key, false);
		}
		this.#setIdentity(identity);

		// Hand each band scale the engine's live id -> value array, so it can build
		// its slot table. This must happen for EVERY band axis, not only the ones
		// whose domain came from the dim: a sorted axis takes the ranking-query
		// path and an explicit domain skips the domain fetch altogether, and if
		// either were left without identity values its slot table would be empty
		// and the shader would read another scale's slots at offset 0.
		for (const { axis, key } of axes) {
			const identity = this.#queryEngine.identityFor(key);

			// An all-NULL column builds an empty dim, which reads as "no identity"
			// because hasIdentity is length > 0. The chart is then correctly empty
			// but silently so, and once the string fallback is gone there is
			// nothing else for it to fall back to. Say it out loud.
			if (identity.values.length === 0) {
				console.warn(
					`[${this.#markId}] "${key}" has no non-NULL values, so the ${axis} axis has no ` +
						`categories and this mark will render nothing.`
				);
			}

			const scale = (
				axis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState
			) as BandScaleState | null;
			scale?.setIdentity(identity);
		}

		// The facet scale adopts too: its displayOrder is what turns a cell index
		// into the id that cell renders, which the frame uniform reads.
		if (facetKey) {
			const facetScale = this.#chartContext.facetBandScale as BandScaleState | null;
			facetScale?.setIdentity(this.#queryEngine.identityFor(facetKey.key));

			// An explicit cell order, applied HERE rather than where the prop is
			// declared. ScaleRegistry ref-counts scales by chart id and calls
			// destroy() — which clears #explicitDomain and #extents — the moment
			// usage hits zero, leaving the same instance in the registry to be
			// handed back empty. A faceted container hits that every time: it
			// registers the scale under its own chart id, becomes a grid, and its
			// own usage drops to zero before the cells' marks mount. Anything
			// registered before that point is wiped by design.
			//
			// Mark setup runs after the wipe, and re-runs after any later one, so
			// this is the first moment the ordering can survive. Keyed by a
			// constant so several marks on one facet scale overwrite rather than
			// accumulate.
			const fxDomain = this.#chartContext.fxDomain;
			if (facetScale && fxDomain?.length) {
				facetScale.addMark(fxDomain, '__fx-explicit', { explicit: true });
			}
		}

		// The colour scale adopts too, and turns ids into stable palette ranks.
		if (colorKey) {
			this.#colorScaleState?.setIdentity(this.#queryEngine.identityFor(colorKey.key));
		}

		// The synthetic "Other" bucket has no row in any table, so its id has to
		// be reserved before a transform can write it. Reserved for every
		// categorical field of this mark rather than guessing which axis topN
		// will pick — at most two, and the transform looks its own field up.
		if (this.#transformCompiler.hasSyntheticOtherBucket()) {
			const otherIds: Partial<Record<'x' | 'y', number>> = {};
			for (const { axis, key } of axes) {
				const id = await this.#queryEngine.reserveSyntheticIdentity(key, 'Other');
				otherIds[axis] = id;

				// Re-adopt: the reservation appended to the value array, and a scale
				// that adopted before it must see the new entry.
				const scale = (
					axis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState
				) as BandScaleState | null;
				scale?.setIdentity(this.#queryEngine.identityFor(key));
				// And tell it WHICH id is the bucket, so an entrance can come out of
				// Other and an exit can go into it rather than past the end of the
				// axis. With an Other bucket that is where the value actually goes.
				//
				// Set on EVERY categorical axis, like the reservation above, rather
				// than re-deriving which axis topN picked — that derivation living
				// in two places is what silently dropped the Other row once already.
				// The axes topN did not pick are unaffected: their reserved id is on
				// no row, so it is never displayed, and setOtherId documents why an
				// undisplayed id cannot act as a gateway.
				scale?.setOtherId(id);
			}
			// topN buckets past its cutoff into these ids. The query parts rebuild:
			// anything assembled before the reservation had no id and left Other
			// out.
			// On the same entry as the axis's dim, keyed by the channel topN
			// resolves its band to. Kept as a separate map keyed by the source
			// field, every lookup once missed and the Other row was silently
			// dropped; one entry per channel cannot disagree with itself.
			//
			// Read after the awaits: a reset in between leaves nothing to add to.
			const current = this.#identity;
			if (current) {
				const withOther = { ...current };
				for (const [axis, otherId] of Object.entries(otherIds)) {
					if (withOther[axis]) withOther[axis] = { ...withOther[axis], otherId };
				}
				this.#setIdentity(withOther);
			}
		}
	}

	/**
	 * The one writer of identity: the reactive copy the query parts read, and
	 * the transforms' copy on #transformConfig — the same object the compiler
	 * holds by reference, so transforms that run later see it.
	 */
	#setIdentity(identity: Record<string, ChannelIdentity> | null): void {
		this.#identity = identity;
		if (identity) this.#transformConfig.identity = identity;
		else delete this.#transformConfig.identity;
	}

	/**
	 * The axis whose rows are one per category, in category order — or null.
	 *
	 * The precondition for morphing: interpolating `from[i]` to `to[i]` means
	 * something only while row `i` is the same category in both. A query
	 * returning one row per surviving group does not give that — filter a
	 * category to nothing and every row after it shifts up — and interpolating
	 * across that produces values belonging to no category at all.
	 *
	 * It is also which axis is the BAND, which is everything a renderer needs:
	 * the band's channels carry ids that resolve through the slot table and are
	 * never mixed, the other axis's channels morph, and the band scale owns the
	 * clock both run on.
	 *
	 * The first channel of the transforms' alignment — `dense()`'s plan, over the
	 * same select and facts its `apply()` sees — so the conditions are written
	 * once. Derived rather than recorded at apply time: apply runs for every
	 * query assembled from this mark, not only the one whose rows reach the GPU.
	 */
	alignedBand: 'x' | 'y' | null = $derived.by(() => {
		const parts = this.#resolvedQueryParts;
		if (!parts) return null;
		// Identity setup fills in what dense() reads; see the field.
		void this.#identity;
		// Asked exactly as assembleQuery asks when it orders the query, so this and
		// the rows cannot disagree about which channel they are aligned on.
		const band = this.#transformCompiler.alignment(Object.keys(parts.selectDef), {
			groupKeys: parts.groupKeys
		})?.[0];
		return band === 'x' || band === 'y' ? band : null;
	});

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
		// No sort configured means this mark has NO OPINION about display order,
		// so it must not express one. The branch below used to answer that case
		// with SELECT DISTINCT and hand the result to setSortOrder, which was
		// harmless only for as long as setSortOrder did nothing: it stored the
		// order and never applied it. Making the re-sort path work made
		// this live, and #explicitDomain ?? #sortOrder gives it priority — so
		// every band mark without a `sort` prop silently took its axis order
		// from an UNFILTERED DISTINCT over the base table instead of from its
		// own data. topN marks are where it showed: survivors landed in
		// whatever order DISTINCT returned rather than by the measure.
		//
		// Returning also drops a per-band-mark round trip that never had a
		// reader.
		if (!sort) return;

		// Read from #resolvedSelect, not #config.select. A band/point axis can be a
		// computed expression (e.g. y={bin('body_mass', {step:500})} on a BarMarkX),
		// and an AutoBinNode is a plain class rather than an ExprNode — so the raw
		// config value both stringifies to "[object Object]" and carries none of the
		// bin resolution the rendered query uses. Taking the resolved form fixes the
		// invalid SQL and keeps this sidecar's binning identical to the chart's.
		const select = this.#resolvedSelect;
		if (!select) return;

		const field = select[axis];
		if (!field) return;

		// Anything that is neither a string nor an ExprNode would stringify to
		// "[object Object]" and produce SQL that fails at the binder. AutoBinNode and
		// RollingAvgNode are both such wrappers, and #resolvedSelect has already
		// replaced them — so reaching this means resolution did not happen, which is
		// worth a warning rather than a query that cannot be read.
		if (!isNode(field) && typeof field !== 'string') {
			console.warn(
				`[MarkLifecycleV2] Sort domain skipped for ${axis}: unresolved expression`,
				field
			);
			return;
		}

		// Only strings become column refs; expression nodes pass through as-is.
		const axisExpr: ExprValue = isNode(field) ? (field as ExprNode) : sqlColumn(String(field));

		let q = Query.from(this.#config.table).select({ [axis]: axisExpr });

		// `sort` is non-null past the guard at the top, so there is no DISTINCT
		// fallback here any more — an unsorted mark never reaches this function.
		const sortField =
			select[sort.channel] || select[sort.channel + '2'] || select[sort.channel + '1'];
		if (!sortField) return;

		if (isAggregateExpression(sortField as ExprNode)) {
			q = q.groupby(axisExpr as GroupByExpr).select({ _sort: sortField as ExprValue });
		}
		const sortExpr = isAggregateExpression(sortField as ExprNode)
			? sqlColumn('_sort')
			: isNode(sortField)
				? sortField
				: sqlColumn(String(sortField));

		q.orderby(sort.direction === 'desc' ? sql`${sortExpr} DESC` : sortExpr);

		try {
			const result = await this.#queryEngine.query(q);
			if (this.#destroyed) return;

			const categories = Array.from(result).map((row: any) => row[axis]);
			if (axis === 'y') categories.reverse();

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
	#buildQueryForAggregates(_table: string, _config: any, filter: unknown[]): Query | null {
		// Build raw query parts directly from config.select (no identity columns,
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
	buildViewportCountQuery(xLo: number, xHi: number, yLo: number, yHi: number): string | null {
		if (!this.setupComplete || !this.#resolvedQueryParts) return null;

		const filter = this.#filterGroup.selection.predicate(this.#markId) ?? [];
		const q = assembleQuery({
			table: this.#sourceTable,
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

	/**
	 * Whether this mark's scales can be drawn against. Every mark component gates
	 * its renderer on it, so a chart whose scales are not usable has no layers
	 * and draws nothing.
	 *
	 * READINESS OF SCALE STATE, and nothing else — which is the boundary worth
	 * knowing, because it reads like a general "is this chart safe to draw" and
	 * is not. It says the scale objects exist, are ready, and have a domain. It
	 * says nothing about the COORDINATOR's view of them: which scale a chart's
	 * shaders actually resolve through when they run.
	 *
	 * Those are different failures, and the second one is invisible from here. A
	 * chart can pass every check in this getter — right scale, right domain,
	 * right slot table, right axis — and still render every mark through another
	 * chart's band layout, because nothing is UNREADY; something derived from
	 * the scale has gone stale on the way to the GPU. Gating harder cannot catch
	 * that, whatever the gate.
	 *
	 * How the coordinator holds that view is its business and has changed: today
	 * it is an index cached in the chart's frame uniform, kept true by
	 * reconciling it per frame rather than by pushing it on every writer, and
	 * the immediates work replaces it with the scale's params written into the
	 * pass, where there is no cache to go stale. What does not change is the
	 * boundary — this getter answers for the scale, not for what the shader
	 * reads.
	 */
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
				// in distance math).
				//
				// Band/point axes: an axis WITH identity already selects the view's
				// id column, which is a cast node rather than a raw column ref, so
				// it falls through to the plain CAST below and the tooltip table
				// carries ids — matching TooltipManager, which translates slot <->
				// id through the live scale (see its BAND IDENTITY section).
				//
				// There is no longer a band axis that arrives here as raw category
				// strings: #inlineIdentityColumns always selects the id column, and
				// an axis it cannot dim is reported at setup. The CASE re-inlining
				// that used to live here — rebuilding a domain-ordered index for
				// the tooltip because skipBandIndex had left strings in the main
				// query — is deleted with it.
				const selectConfig = this.#config.select;
				const resolvedSelect = this.#resolvedQueryParts?.selectDef ?? {};
				const schema = this.#schema;
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
						// A non-numeric raw column reaching a positional channel is not
						// something the tooltip can measure distance on. Left as-is.
						continue;
					}
					replaceExprs.push(`CAST(${c} AS DOUBLE) AS ${c}`);
				}
				const replaceClause =
					replaceExprs.length > 0 ? ` REPLACE (${replaceExprs.join(', ')})` : '';

				// Optional ORDER BY for zone-map skipping in bounding-box queries.
				let orderClause = '';
				const tooltipSortTable =
					typeof this.#reactiveConfig.tooltip === 'object'
						? this.#reactiveConfig.tooltip.sortTable !== false
						: true;
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

				// Band axis columns arrive as numeric identity ids on every path now,
				// so the string -> index conversion this used to do is gone with the
				// rest of the string path.
				// Infer schema from first row
				const schemaDef = columns
					.map((col) => {
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
			table: this.#sourceTable,
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
	async #mergeTipExtras(tableName: string, tipExtras: Record<string, unknown>): Promise<void> {
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
			table: this.#sourceTable,
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
		const joinCondition = joinCols.map((ch) => `"${tableName}"."${ch}" = _s."${ch}"`).join(' AND ');
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
			const q = Query.from(this.#tooltipTableName).select(outerSelect as Record<string, ExprValue>);
			if (whereClause) q.where(whereClause as any);
			return q;
		}

		// Path A: CTE-wrap the mark's base query
		return this.#buildSidecarQuery(outerSelect, whereClause);
	}

	#buildFitDomainWhere(drivingChannels: string[], domain: [number, number]): unknown {
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
	#buildSidecarQuery(outerSelect: Record<string, unknown>, where?: unknown): Query | null {
		const tooltipQuery = this.#buildTooltipQuery();
		if (!tooltipQuery) return null;
		const q = Query.from({ mark_data: sql`(${tooltipQuery})` as any }).select(
			outerSelect as Record<string, ExprValue>
		);
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
		this.#identityResetOff?.();
		this.#identityResetOff = null;
		this.#handle?.destroy();
		clearTimeout(this.#fitDomainTimeout!);
		clearTimeout(this.#tooltipWriteTimeout!);

		if (this.#adaptiveBinRung) {
			this.#adaptiveBinRung.destroy();
			this.#adaptiveBinRung = null;
		}

		// Defensive tooltip table cleanup. The tooltip $effect cleanup
		// also drops the table on unmount. This explicit DROP covers the case
		// where destroy() is called synchronously before Svelte processes
		// effect teardown.
		this.#tooltipTableReady = false;
		this.#queryEngine.exec(`DROP TABLE IF EXISTS "${this.#tooltipTableName}"`).catch(() => {});
	}
}
