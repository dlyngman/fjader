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
 *   Engine handles filter-driven re-queries via onClauseChange() and
 *   onFilterChange().
 *
 * Params: watches sort/limit on ReactiveConfig.
 *   Changes trigger re-query for this mark only, no teardown.
 */

import type { EntranceGate } from '$lib/animation/EntranceGate';
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
import type { ExprNode, ExprValue, FilterExpr, GroupByExpr } from '@uwdata/mosaic-sql';
import type { ScaleRequirement } from '$lib/scales/ScalePriorities';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { binLimit, withDenseCategories, withoutOtherMembers, withRanking } from '$lib/transforms';
import { markValueAxis } from '$lib/transforms/value-axis';
import { ArrowDataAccessor } from '$lib/data/DataAccessor';
import type { DataAccessor } from '$lib/data/DataAccessor';
import type {
	FieldRef,
	NormalizedSortConfig,
	Transform,
	BinPadding,
	BinWindow,
	ChannelIdentity,
	MarkConfig,
	ChartContext,
	ScaleStateInstance,
	ContinuousScaleState,
	NullsResponse
} from '$lib/types';
import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import type { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { SizeScaleState } from '$lib/scales/SizeScaleState.svelte';
import type { QueryEngine, StatementClass } from '$lib/query-engine/QueryEngine';
import { MarkHandle } from '$lib/query-engine/MarkHandle.svelte';
import type { FilterGroup } from '$lib/query-engine/FilterGroup.svelte';
import { isContinuousScale, isTemporalScale } from '$lib/scales/scale-categories';
import { buildSchemaMap, type ColumnSchema } from '$lib/query-engine/QueryEngine';
import { type AutoBinNode, isBinExpression, rebinLevel } from '$lib/sql/bin';
import { isRollingAvgExpression } from '$lib/sql/rolling-avg';
import { isWindowExpression } from '$lib/sql/expression-utils';
import { identityKeyFor } from '$lib/query-engine/identity-key';
import type { MarkRoute } from '$lib/query-engine/CrossfilterSelection.svelte';
import {
	activityReads,
	dimsBySelection,
	groupIndexForResponse,
	NO_READS,
	readsFor,
	readsForResponse,
	rendererForMark,
	type SelectionResponse
} from '$lib/components/rendering/activity-reads';

import { AdaptiveBinRung } from '$lib/lod/AdaptiveBinRung.svelte';
import { countRowsInView, type HeldCount } from '$lib/lod/DensityHost.svelte';
import type { LODRung, MarkLODParts, MarkLODSurface } from '$lib/lod/rung-types';
import { generateMarkId, buildChannelFieldMap, resolveSortChannel } from '../utils';
import { buildExpressionLabel, isLabeledTipEntry } from '../utils/channel-field-map';
import { detectChannelsNeedingDataDomain } from './domain-computation';
import {
	extentFromFitRow,
	fitChannels,
	fitSelect,
	fitWindowWhere,
	windowEdges,
	windowedFit,
	withBaseline
} from './fit-domain';
import { binLayout } from './bin-layout';
import { layoutFor, rowLayoutOf, RUNS, type ReadableLayout, type RowLayout } from './row-layout';
import {
	buildBinCut,
	buildBinRemap,
	isNested,
	type BinCut,
	NEST_EPSILON,
	type BinRemapSide,
	type ForwardWhy,
	type RebinDecision,
	type RebinSource
} from '$lib/gpu/bin-remap';
import {
	binExtent,
	binWindowFor,
	binWindowNeedsMove,
	insideBinWindow,
	viewInBinUnits,
	windowCoversRange,
	windowPaddedBins
} from './bin-window';
import { binRowsMoved, binSpecKey, heldCoversView, isRebin, rebinTweens } from './rebin';
import { SETTLE_MS } from '$lib/components/charts/ChartHover.svelte';
import {
	buildQueryParts,
	assembleQuery,
	windowSourceFilter,
	isPositionalChannel,
	measureChannels,
	pathGapChannels,
	tipExtrasStatement,
	ident,
	castReal,
	type NullDrop,
	type QueryParts
} from './query-builder';
import {
	setScalesReady,
	markDeferredScalesReady,
	setInitialContinuousDomains,
	registerDataDerivedDomains
} from './domain-registration';
import { fetchCategoricalDomains, fetchGlobalAggregates } from './domain-queries';
import { transformScaleKey } from './transform-scale-key';
import { OtherRows, type SplitPlan } from './other-rows.svelte';
import type { PlaceExtent, PlaceColumnExtent } from '$lib/components/charts/MarkContributions';

/** One result's rows as a remap reads them, with the bins and window they were computed over. */
type TakenSide = BinRemapSide & { binKey: string | null; window: BinWindow | null };

/** A side's span: its first facet's first and last bins, at the series stride. */
function sideSpan(side: TakenSide): [number, number] | null {
	const { bins, series } = side.layout;
	if (bins === 0) return null;
	return [Number(side.lower[0]), Number(side.upper[(bins - 1) * series])];
}

/**
 * A side's bin width, read at its middle bin: the end bins can be clipped to
 * the extent, and months differ by a few days, which is still far from a
 * rebin's factor.
 */
function middleBinWidth(side: TakenSide): number {
	const { bins, series } = side.layout;
	const at = Math.floor(bins / 2) * series;
	return Number(side.upper[at]) - Number(side.lower[at]);
}

// ---------------------------------------------------------------------------
// Config (same shape as MarkLifecycleConfig — shared during transition)
// ---------------------------------------------------------------------------

/**
 * The fewest steps across the view a path mark's view-scaled bins may have
 * (AutoBinNode's `minSteps`). The chart's step multiplier goes down to a tenth,
 * and a view far wider than the data coarsens the bins further: a histogram of
 * two bars is still a histogram, a line of two points is a segment.
 */
const PATH_MIN_STEPS = 8;

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
	/**
	 * A mark that joins its rows into a path: the row layouts its renderer can
	 * address (row-layout.ts). A result laid out any other way is refused, with
	 * an error, instead of drawn wrongly or not at all. Absent for marks that
	 * draw each row on its own.
	 */
	_rowLayouts?: readonly ReadableLayout[];
	zeroBaseline?: { x?: boolean; y?: boolean };
	/**
	 * A rule's: whether it spans an extent on its cross axis (RuleX with
	 * y1/y2, RuleY with x1/x2, constants included). Decides whether it reads
	 * that axis's selection activity.
	 */
	ruleExtent?: boolean;
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
	readonly domain: { x?: string[]; y?: string[] } | null | undefined;
	readonly tooltip: boolean | { sortTable?: boolean };
	readonly fitDomain: 'x' | 'y' | boolean | undefined;
	readonly tip: (unknown | '*')[] | false | undefined;
	readonly selectionResponse: SelectionResponse | undefined;
	readonly nulls: NullsResponse | undefined;
	readonly contributeDomain: boolean | undefined;
	readonly holdsEntrance: boolean | undefined;
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
	/**
	 * Before each extent write: the chart records where the mark's extent lands
	 * and refuses it once the mark has left (ChartContext.placeExtent). Bound
	 * once, so the write path allocates nothing.
	 */
	readonly #placeExtent: PlaceExtent = (axis, state) =>
		this.#chartContext.placeExtent(this.#markId, axis, state);
	readonly #placeColumnExtent: PlaceColumnExtent = (column, state) =>
		this.#chartContext.placeColumnExtent(this.#markId, column, state);
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
	/** Whether this lifecycle registered the mark's MarkLODSurface, to undo it on destroy. */
	#lodRegistered = false;
	/** The mark's `onMarkLOD`, told of the surface and of its going. */
	#onMarkLOD: ((surface: MarkLODSurface | null) => void) | null = null;

	// --- Engine Registration ---
	#handle = $state<MarkHandle | null>(null);

	// --- Semantic select ($derived — recomputes on bin/config changes) ---
	//
	// Channel expressions with their *meaning* resolved — an AutoBinNode becomes a
	// concrete bin expression, a RollingAvgNode becomes a window function — but not
	// yet encoded for the GPU.
	//
	// Split out of #resolvedQueryParts: this selects category *values*, so it sees
	// resolved bins but not #inlineIdentityColumns below, which swaps a categorical
	// channel for its dim's id column.
	#resolvedSelect: Record<string, unknown> | null = $derived.by(() => {
		if (!this.setupComplete) return null;

		const resolvedSelect = { ...this.#config.select };

		// Resolve AutoBinNodes — reads #fieldStats ($state), #lastBinDomain ($state),
		// binStepMultiplier (reactive on chartContext)
		if (this.#autoBinNodes.size > 0 && this.#fieldStats) {
			for (const [ch, value] of Object.entries(resolvedSelect)) {
				if (isBinExpression(value)) {
					const {
						fieldInfo,
						scaleType,
						currentDomain,
						multiplier,
						maxBins,
						minSteps,
						paddedCount
					} = this.#binArgs(ch);
					resolvedSelect[ch] = value.resolve(
						fieldInfo,
						scaleType,
						null,
						currentDomain,
						multiplier,
						maxBins,
						minSteps,
						paddedCount
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

	/**
	 * What a padded row holds on a mark that draws rows as points along a path
	 * (MarkConfig.gaps, absentSeriesGap): a gap for a positional measure with no
	 * value over no rows, and nothing for the absent series when it is empty. Nothing for a
	 * mark whose rows span their bins (it shrinks them to zero), or under a SQL
	 * stack, which sums the rows of a bin: there a padded row stays 0.
	 */
	#pathPadding(config: MarkLifecycleV2Config): Pick<MarkConfig, 'gaps' | 'absentSeriesGap'> {
		if (!config._rowLayouts) return {};
		const stacked = (config.transforms ?? []).some(
			(transform) => transform.type === 'stack' && transform.stage === 'sql'
		);
		if (stacked) return {};
		return { gaps: pathGapChannels(config.select), absentSeriesGap: true };
	}

	/**
	 * The series a path mark's topN ranks (MarkConfig.rankedSeries): its series
	 * channel, on a line or an area with a topN. Null otherwise, and for a bar,
	 * whose topN ranks its band.
	 */
	#rankedSeries(config: MarkLifecycleV2Config): string | null {
		if (!config._rowLayouts) return null;
		if (!(config.transforms ?? []).some((transform) => transform.type === 'topN')) return null;
		return config._orderConfig?.seriesChannel ?? null;
	}

	// --- Structural query parts ($derived — recomputes on bin/scale/config changes) ---
	#resolvedQueryParts: QueryParts | null = $derived.by(() => {
		const semanticSelect = this.#resolvedSelect;
		if (!semanticSelect) return null;

		// Copy before the inline helpers below, which mutate in place — #resolvedSelect
		// must not carry GPU encodings.
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
		const nullDrops = this.#nullDrops(semanticSelect, resolvedSelect);
		if (nullDrops.length > 0) parts.nullDrops = nullDrops;
		parts.bins = this.#binPadding();
		// Once per parts, not per result: each result compares it (#takeBinStep).
		parts.binKey = binSpecKey(parts.bins);

		return parts;
	});

	/**
	 * What a bin channel resolves with: the field's stats, the axis's scale
	 * type and last re-bin domain, and the chart's step multiplier. One place,
	 * so the bin expression and its padding cannot be resolved differently.
	 * Reactive reads, from the deriveds that call it.
	 *
	 * A path mark's bins are capped by what its padding holds (#maxBins): the
	 * window's bins while it pads one (`paddedCount`), else the whole extent's.
	 * `padsWindow` asks for a window about to be set (#windowBand).
	 */
	#binArgs(channel: string, padsWindow?: boolean) {
		const axis = channel.startsWith('x') ? 'x' : 'y';
		return {
			axis,
			fieldInfo: this.#fieldStats as Record<string, { min?: number; max?: number; type?: string }>,
			scaleType: axis === 'x' ? this.actualXScaleType : this.actualYScaleType,
			currentDomain: this.#lastBinDomain[axis] ?? null,
			multiplier: this.#chartContext.binStepMultiplier || 1.0,
			maxBins: this.#maxBins(),
			// A path of two points is not a line of anything: see PATH_MIN_STEPS.
			minSteps: this.#config._rowLayouts ? PATH_MIN_STEPS : 1,
			// #padsWindow read for a path only: any other mark's bins must not depend
			// on its window, or setting or clearing one would re-register it.
			paddedCount:
				this.#config._rowLayouts && axis === this.#binnedAxis() && (padsWindow ?? this.#padsWindow)
					? windowPaddedBins
					: undefined
		} as const;
	}

	/**
	 * Whether the mark pads a window now (a window is set on its handle). A
	 * boolean of its own, so a window that moves does not recompute the bins.
	 */
	#padsWindow: boolean = $derived(this.#handle?.params.binWindow != null);

	/**
	 * The most bins this mark's binned axis may have: a bound for a PATH mark,
	 * which is only right when padded. An unpadded stacked area skips the series
	 * with no row in a bin and its bands overlap; an unpadded line of means draws
	 * across the gap its empty bin was. Padding refuses past its row limit, and
	 * bins that follow the view pass it under zoom, so they are held where bins
	 * × series × facets still fits (transforms' binLimit, the limit's own
	 * arithmetic). Applied always, not only under zoom: a path with so many
	 * series that its default bins pass the limit gets fewer bins, and is padded.
	 *
	 * Infinity for a mark that draws each row on its own (bars survive missing
	 * rows, and a windowed histogram pads only its view), before identity setup,
	 * and where the series alone pass the limit. Read from the deriveds that
	 * resolve the bins, so it follows identity setup.
	 */
	#maxBins(): number {
		if (!this.#config._rowLayouts) return Infinity;
		const identity = this.#identity;
		if (!identity) return Infinity;
		const keys: string[] = [];
		const binned = new Set<string>();
		for (const [channel, value] of Object.entries(this.#config.select)) {
			if (value == null) continue;
			if (isBinExpression(value)) {
				binned.add(channel);
			} else if (
				!isRollingAvgExpression(value) &&
				!(isNode(value) && (isAggregateExpression(value as ExprNode) || isWindowExpression(value)))
			) {
				keys.push(channel);
			}
		}
		if (binned.size === 0) return Infinity;
		// The chart's facet is a group key the select does not hold.
		if ('__facet' in identity) keys.push('__facet');
		return binLimit(keys, identity, binned);
	}

	/**
	 * Whether a binned axis's bins are held at a bound: `finest` at #maxBins (the
	 * view or the step multiplier asks for more than can be padded), `coarsest`
	 * at a path's fewest steps. For the palette's readout, and for
	 * the count a line's dots are judged by (countInView).
	 */
	get binsHeld(): 'finest' | 'coarsest' | null {
		if (!this.#fieldStats) return null;
		for (const [channel, node] of this.#autoBinNodes) {
			const {
				axis,
				fieldInfo,
				scaleType,
				currentDomain,
				multiplier,
				maxBins,
				minSteps,
				paddedCount
			} = this.#binArgs(channel);
			// At the view as it is, not at the last re-bin's: a held mark does not
			// re-bin (the bins at the next level are the same bins), so the domain
			// of its last re-bin stays one from before the bound, and asked there
			// the bins are never held.
			const view = axis === this.#binnedAxis() && this.#lastView ? this.#lastView : currentDomain;
			return node.held(fieldInfo, scaleType, view, multiplier, maxBins, minSteps, paddedCount);
		}
		return null;
	}

	/**
	 * The bins of each numeric bin channel, for dense() to pad from; null without
	 * any. With `at`, the bins they would have with that axis's view at `domain`
	 * (and, given, with or without a window: #binArgs).
	 */
	#binPadding(at?: {
		axis: 'x' | 'y';
		domain: [number, number];
		padsWindow?: boolean;
	}): Record<string, BinPadding> | null {
		if (this.#autoBinNodes.size === 0 || !this.#fieldStats) return null;
		let out: Record<string, BinPadding> | null = null;
		for (const [ch, value] of Object.entries(this.#config.select)) {
			if (!isBinExpression(value)) continue;
			const {
				axis,
				fieldInfo,
				scaleType,
				currentDomain,
				multiplier,
				maxBins,
				minSteps,
				paddedCount
			} = this.#binArgs(ch, at?.padsWindow);
			const padding = value.padding(
				fieldInfo,
				scaleType,
				at?.axis === axis ? at.domain : currentDomain,
				multiplier,
				this.#timeOrigin(axis),
				maxBins,
				minSteps,
				paddedCount
			);
			if (padding) (out ??= {})[ch] = padding;
		}
		return out;
	}

	/** The binned field's extent per axis, for #viewLevel: recomputed when the stats change. */
	#levelExtent: { stats: unknown; xType: string; yType: string; x: number; y: number } = {
		stats: null,
		xType: '',
		yType: '',
		x: NaN,
		y: NaN
	};

	/**
	 * The rebin level of a view [lo, hi] on a binned axis (sql/bin.ts,
	 * rebinLevel): what the bins are resolved from, and what the rung compares to
	 * decide a re-bin. 0 where the axis's bins do not follow the view, or before
	 * the field's statistics. Called every frame by the rung: allocates nothing
	 * once the extents are cached.
	 */
	#viewLevel(axis: 'x' | 'y', lo: number, hi: number): number {
		const stats = this.#fieldStats;
		if (!stats) return 0;
		const cache = this.#levelExtent;
		const xType = this.actualXScaleType;
		const yType = this.actualYScaleType;
		if (cache.stats !== stats || cache.xType !== xType || cache.yType !== yType) {
			cache.stats = stats;
			cache.xType = xType;
			cache.yType = yType;
			cache.x = NaN;
			cache.y = NaN;
			for (const [channel, node] of this.#autoBinNodes) {
				const of = channel.startsWith('x') ? 'x' : 'y';
				if (!node.followsView || !Number.isNaN(cache[of])) continue;
				cache[of] = node.extentWidth(stats, of === 'x' ? xType : yType);
			}
		}
		return rebinLevel(hi - lo, cache[axis]);
	}

	/**
	 * Whether the bins resolved with `axis`'s view at [lo, hi] are other bins
	 * than the current parts'. Neighbouring levels often round to the same nice
	 * step, and those need no query. True when either cannot be told (no padding:
	 * a time axis without an origin yet, a field with one value).
	 */
	#binsDifferAt(axis: 'x' | 'y', lo: number, hi: number): boolean {
		const current = this.#resolvedQueryParts?.binKey ?? null;
		const next = binSpecKey(this.#binPadding({ axis, domain: [lo, hi] }));
		return current === null || next === null || current !== next;
	}

	/**
	 * The mark's categorical channels, each with the source expression it draws:
	 * a band or point axis, an ordinal colour, a separate series, and the facet
	 * (`__facet`, from the chart's fx). What `nulls="drop"` filters.
	 */
	#categoricalChannels(select: Record<string, unknown>): [channel: string, source: unknown][] {
		const out: [string, unknown][] = [];
		const categorical = (type: string) => type === 'band' || type === 'point';
		if (categorical(this.actualXScaleType)) out.push(['x', select.x]);
		if (categorical(this.actualYScaleType)) out.push(['y', select.y]);
		const colorChannel = this.#config.colorChannel || 'fill';
		if (this.#colorScaleState?.isOrdinal) out.push([colorChannel, select[colorChannel]]);
		const seriesChannel = this.#config._orderConfig?.seriesChannel ?? null;
		if (seriesChannel && seriesChannel !== colorChannel) {
			out.push([seriesChannel, select[seriesChannel]]);
		}
		if (this.#chartContext.fx) out.push(['__facet', this.#chartContext.fx]);
		// Only row-level values: an aggregate has no NULL category to drop.
		return out.filter(
			([, source]) =>
				source != null &&
				typeof source !== 'number' &&
				!(isNode(source) && isAggregateExpression(source as ExprNode))
		);
	}

	/**
	 * `nulls="drop"`, by channel (see QueryParts.nullDrops). A channel the query
	 * selects as its dim's id column drops the NULL category's id; one still
	 * carrying its raw value (identity not landed yet) drops SQL NULL. Read off
	 * the select itself, so the two cannot disagree: inlining an id column is
	 * what changes the channel's expression.
	 */
	#nullDrops(semantic: Record<string, unknown>, resolved: Record<string, unknown>): NullDrop[] {
		if (this.#reactiveConfig.nulls !== 'drop') return [];
		const drops: NullDrop[] = [];
		for (const [channel, source] of this.#categoricalChannels(semantic)) {
			const encoded = channel === '__facet' ? '__facet' in resolved : resolved[channel] !== source;
			if (channel === '__facet' && !encoded) continue;
			const key = encoded ? identityKeyFor(source as FieldRef)?.key : null;
			const nullId = key ? this.#queryEngine.identityFor(key).nullId : null;
			drops.push({ channel, nullId });
		}
		return drops;
	}

	/**
	 * `nulls="drop"` for a query over the RAW select (no id columns, no
	 * `__facet`): `<source> IS NOT NULL` per categorical channel, the facet's
	 * on the chart's fx. Passed as that query's filter.
	 */
	#rawNullFilters(select: Record<string, unknown>): unknown[] {
		if (this.#reactiveConfig.nulls !== 'drop') return [];
		return this.#categoricalChannels(select).map(([, source]) =>
			isNotNull((typeof source === 'string' ? sqlColumn(source) : source) as ExprValue)
		);
	}

	// --- Domain State ---
	#channelsNeedingDataDomain: Set<string> = new Set();
	#dataDerivedDomainsSet = $state(false);
	#globalAggregatesSet = $state(false);
	#skipDomainUpdateForAxis: string | null = null;
	#lastBandDomainDataVersion: number | null = null;
	/**
	 * Whether this mark's band axis is decided by its query results rather than
	 * by the dim: topN decides membership, and `sort` decides order through the
	 * rank column. Sticky once set, so a mark whose sort is later removed still
	 * re-registers from its data and withdraws the ranking it had claimed.
	 */
	#bandDomainFromData = false;

	/**
	 * The sort that ranks this mark's band axis, or null.
	 *
	 * An explicit `domain` on the same axis wins outright, as it did when sort
	 * was a sidecar: the ranking is not computed and the axis is not taken from
	 * the data, so the listed categories are shown in the listed order.
	 */
	get #rankingSort(): NormalizedSortConfig {
		const given = this.#reactiveConfig.sort ?? null;
		if (!given) return null;
		if (this.#reactiveConfig.domain?.[given.axis]?.length) return null;
		// A column name becomes the channel that reads it: the rank transform
		// reads the query's channel aliases.
		const fieldMap = this.channelFieldMap;
		const categorical = new Set(this.#categoricalChannels(this.#config.select).map(([ch]) => ch));
		const { sort, problem } = resolveSortChannel(given, fieldMap, categorical);
		if (problem && this.#unresolvedSortWarned !== given.channel) {
			this.#unresolvedSortWarned = given.channel;
			const why =
				problem === 'categorical'
					? 'is read only by a categorical channel, which has no values to sort by'
					: 'is neither a channel nor a column of this mark';
			console.warn(
				`sort: "${given.channel}" ${why} (channels: ${Object.keys(fieldMap).join(', ')}), ` +
					`so the ${given.axis} axis is not sorted.`
			);
		}
		return sort;
	}

	/** The unresolved sort name last warned about, so a getter read often warns once. */
	#unresolvedSortWarned: string | null = null;

	// --- Tooltip ---
	#tooltipTableName: string;
	#tooltipTableReady = $state(false);
	/** Whether the chart was gesturing at the tooltip effect's last run. Plain. */
	#tooltipGesturing = false;
	/**
	 * True once a tooltip table write has started, so there may be a table to
	 * drop. Without it every lifecycle torn down before its first data (a mark
	 * that unmounts early, a rebuild) sent DuckDB a DROP for a table that never
	 * existed, one more statement in the single worker's queue during load.
	 */
	#tooltipTableWritten = false;

	#tooltipWriteTimeout: ReturnType<typeof setTimeout> | null = null;

	// --- fitDomain ---
	#fitDomainTimeout: ReturnType<typeof setTimeout> | null = null;
	/**
	 * The data version whose fit snaps instead of springing: the version the
	 * chart came back into view with, or its catch-up result's. A spring means
	 * the user just caused the change; a return to view is not that. Tied to a
	 * version rather than a flag waiting for the next fit: a fit issued for any
	 * other reason (a driving-axis zoom, later data) or skipped clears it, and
	 * a superseded fit for the same version keeps it.
	 */
	#snapFitVersion: number | null = null;
	/** Debounces a refit after a data change (#refitFromData). */
	#refitTimeout: ReturnType<typeof setTimeout> | null = null;
	#fitDomainLastTarget: [number, number] = [0, 0];
	#fitDomainQuerySequence = 0;
	#fitDomainSuppressed = false;
	/** The data version fitted as it landed (a rebin result): its debounced refit is skipped. */
	#fittedVersion = 0;

	// --- Rebin results ---
	/** The bin spec the last result was computed from (#takeBinStep). */
	#lastBinSpec: string | null = null;
	/** A view in the bins' units, reused: #onViewport runs every frame (no allocation). */
	#viewScratch: [number, number] = [0, 0];
	/** The last viewport on the binned axis, in the scale's units (a hold's coverage). */
	#lastView: [number, number] | null = null;
	/**
	 * The rows the renderer last committed (`rebinSource`), as a remap reads
	 * them. Holds references to that result's columns, so the previous table
	 * stays in memory until the next commit: binned data, bounded by the dense
	 * row limit.
	 */
	#takenSide: TakenSide | null = null;
	/** The side the last `takeRebin` read: what `commitLayout` commits. */
	#pendingSide: TakenSide | null = null;

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
			onMarkLOD?: ((surface: MarkLODSurface | null) => void) | null;
			/** The mark's own rungs, beside its bins' (MarkLODParts). */
			lod?: (() => MarkLODParts | null) | null;
		}
	) {
		this.#config = config;
		this.#reactiveConfig = reactiveConfig;
		this.#queryEngine = queryEngine;
		this.#chartContext = chartContext;
		this.#markId = markId;
		this.#filterGroup = filterGroup;

		// The chart's entrance waits for this mark's first data, unless the
		// author has said not to (a mark known to be slow). Held by mark id, so
		// a lifecycle rebuilt for the same mark holds the same hold. Released on
		// first data, on failure, or when the mark unmounts.
		this.#entranceGate = chartContext.config?.entrance ?? null;
		if (config.table && untrack(() => reactiveConfig.holdsEntrance) !== false) {
			this.#entranceGate?.hold(markId);
		}

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
			fill: this.#getFieldName('fill'),
			...this.#pathPadding(config),
			rankedSeries: this.#rankedSeries(config)
		};
		// A getter: transforms read it when they build their SQL, by when the
		// chart has resolved its scales.
		Object.defineProperty(this.#transformConfig, 'valueAxis', {
			get: () => this.#valueAxis,
			enumerable: true
		});
		// `dense()` is added here rather than in each of the twelve mark components
		// that assemble transform lists, and it is added unconditionally: it
		// refuses itself at apply time unless the mark has exactly one dimmed
		// categorical axis that is also a GROUP BY key. That keeps the condition
		// in one place, next to the reason for it, instead of spread across the
		// callers that would each have to re-derive it.
		//
		// `dense: false` on the mark opts out.
		//
		// `rank()` likewise: the `sort` prop is a ranking the query publishes as
		// a column, read through a getter so a changed sort re-queries rather
		// than rebuilding. With no sort it passes the query through.
		this.#transformCompiler = new TransformCompiler(
			withRanking(
				withDenseCategories(config.transforms || [], config.dense !== false),
				() => this.#rankingSort
			),
			this.#transformConfig
		);
		this.#detectAutoBins();

		this.otherRows = new OtherRows({
			queryEngine,
			filterGroup,
			markId,
			table: () => this.#handle?.arrowTable ?? null,
			dataVersion: () => this.dataVersion,
			identity: () => this.#identity,
			identityKey: (axis) => this.#identityKey(axis)?.key ?? null,
			filtered: () => this.#reactiveConfig.selectionResponse === 'filter',
			dims: () => dimsBySelection(this.#reactiveConfig.selectionResponse),
			plan: () => this.#splitPlan,
			colorKey: () => {
				const color = this.#colorScaleState;
				return color?.isOrdinal ? color.identityKey : null;
			},
			bandScaleKey: (axis) => {
				const band = (
					axis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState
				) as BandScaleState | null;
				return band?.identityKey ?? null;
			}
		});

		// AdaptiveBinRung for binned marks (watches viewport domain, triggers rebin).
		// For any mark with a bin() channel: the chart gives the coordinator, so no
		// mark has to ask for it. A path mark's bins are bounded so that it stays
		// padded (#maxBins).
		const gpuCoordinator = chartContext.gpuCoordinator ?? null;
		if (this.#autoBinNodes.size > 0 && gpuCoordinator) {
			const binAxes = [...this.#autoBinNodes.keys()].map(
				(ch) => (ch.startsWith('x') ? 'x' : 'y') as 'x' | 'y'
			);
			this.#adaptiveBinRung = new AdaptiveBinRung(gpuCoordinator, chartContext, {
				binAxes,
				held: () => this.binsHeld,
				levelOf: (axis, lo, hi) => this.#viewLevel(axis, lo, hi),
				binsDiffer: (axis, lo, hi) => this.#binsDifferAt(axis, lo, hi),
				setParam: (_key, value) => {
					const e = chartContext.config.entries.get(markId);
					if (!e) return;
					const current = e.lod;
					const cfg = typeof current === 'object' && current ? current : {};
					chartContext.config.setMarkProp(markId, 'lod', { ...cfg, multiplier: value });
				},
				getData: () => this.data,
				onViewport: (axis, domain) => this.#onViewport(axis, domain),
				triggerReBin: (axis, domain) => this.#rebinTo(axis, domain)
			});
		}

		// The mark's ONE LOD surface: what the palette, the tooltips and
		// shift+scroll reach its rungs through. Built here for any mark with a
		// rung, its bins' or its own (`options.lod`), and registered once: two
		// registrations under one mark id would replace each other.
		const ownLOD = options?.lod ?? null;
		if (this.#adaptiveBinRung || ownLOD) {
			const binRung = this.#adaptiveBinRung;
			const surface: MarkLODSurface = {
				// A binned axis takes the gesture, whichever mark draws it; then the
				// mark's own rungs; then the chart's bins, as with no mark under it.
				adjustResolution: (deltaY) => {
					if (binRung && !binRung.destroyed) return binRung.adjustResolution(deltaY);
					const own = ownLOD?.();
					if (own?.adjustResolution) return own.adjustResolution(deltaY);
					return chartContext.adjustBinMultiplier?.(deltaY < 0 ? 0.035 : -0.035) ?? false;
				},
				getRungs: () => {
					const rungs: LODRung[] = [];
					if (binRung && !binRung.destroyed) rungs.push(binRung);
					for (const rung of ownLOD?.()?.rungs ?? []) {
						if (rung && !rung.destroyed) rungs.push(rung);
					}
					return rungs;
				},
				getDensityCtx: () => ownLOD?.()?.densityHost?.ctx ?? null,
				getDensityHost: () => ownLOD?.()?.densityHost ?? null
			};
			chartContext.config.registerMarkLOD(markId, surface);
			options?.onMarkLOD?.(surface);
			this.#lodRegistered = true;
			this.#onMarkLOD = options?.onMarkLOD ?? null;
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
		// The Other ids name rows of the dropped dims. Every holder lets go, so
		// the scale acquires afresh when setup re-runs; so do the registered rows.
		this.otherRows.unregister();
		for (const scale of [...this.#otherScales]) this.#releaseOther(scale);
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
				if (key) {
					config = {
						...config,
						transformKey: transformScaleKey(table, key, this.#chartContext.config)
					};
				}
			}
			this.#chartContext.registerScaleType(
				'x',
				scaleRequirements.x.type,
				scaleRequirements.x.priority,
				this.#markId,
				config,
				inferredScaleColumns?.x
			);
		} else {
			// The chart keeps one requirement per mark per dimension, replaced by
			// the next registration: a dimension this config no longer declares
			// would otherwise keep its predecessor's.
			this.#chartContext.unregisterScaleType('x', this.#markId);
		}

		if (scaleRequirements?.y) {
			let config = scaleRequirements.y.config || {};
			if (scaleRequirements.y.type === 'band' && hasCatReducing) {
				const key = this.#transformCompiler.getCategoryTransformKey();
				if (key) {
					config = {
						...config,
						transformKey: transformScaleKey(table, key, this.#chartContext.config)
					};
				}
			}
			this.#chartContext.registerScaleType(
				'y',
				scaleRequirements.y.type,
				scaleRequirements.y.priority,
				this.#markId,
				config,
				inferredScaleColumns?.y
			);
		} else {
			this.#chartContext.unregisterScaleType('y', this.#markId);
		}

		if (this.#config.parallelMode && this.#config.parallelColumns) {
			// The whole list: columns this mark no longer has lose their axes.
			this.#chartContext.setParallelColumns(this.#markId, this.#config.parallelColumns);
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

			// Read #colorScaleState and #seriesScaleState REACTIVELY — outside the
			// untrack below — so that attaching either re-enters this effect.
			// #runSetup returns without completing while this is false, which is
			// the only reason the re-entry has anything to do. See there.
			//
			// Series too, since it takes a dim like colour: #ensureIdentityColumns
			// hands the series scale its identity, and a scale that is not there
			// yet would be handed nothing.
			const colorKey = this.#config.colorChannel || 'fill';
			const seriesKey = this.#config._orderConfig?.seriesChannel ?? null;
			const scalesReady =
				(!this.#config.select?.[colorKey] || !!this.#colorScaleState) &&
				(!seriesKey || seriesKey === colorKey || !!this.#seriesScaleState);

			untrack(() => {
				// A run already in flight against these same scales would produce
				// the same result: don't send its queries again. A different scale
				// starts a new run, and the generation guard retires the old one.
				const inputs = [
					xScaleState,
					yScaleState,
					this.#colorScaleState,
					this.#seriesScaleState,
					scaleTypes.x,
					scaleTypes.y
				];
				if (scalesReady && this.#setupInFlight && sameInputs(this.#setupInFlight, inputs)) return;
				this.#runSetup(scalesReady, inputs);
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
			// Read after setup, once the scales have adopted identity. A change of
			// reads or of selectionResponse re-registers the mark: a selection
			// that dimmed it may now filter it. The key is a string, so reads
			// rebuilt with the same contents do not.
			void this.#readsKey;
			const response = this.#reactiveConfig.selectionResponse;

			untrack(() => {
				this.#route = { reads: this.#reads, chart: this.#chartContext.config, response };
				// registerMark handles cleanup of previous registration for this
				// markId and reuses the existing handle (preserves arrowTable
				// during re-query so the chart doesn't flash empty on rebin).
				this.#handle = this.#queryEngine.registerMark(
					this.#markId,
					{
						table: this.#sourceTable,
						baseTable: this.#config.table,
						parts,
						schema,
						transformCompiler: this.#transformCompiler,
						route: this.#route,
						// holdsEntrance={false}: the author knows this mark is slow.
						slow: this.#reactiveConfig.holdsEntrance === false
					},
					this.#filterGroup
				);
			});
		});

		// Off screen, the engine stops re-querying this mark (after its first
		// result) and queries it once when it is back; see MarkHandle.active.
		//
		// The one owner of a return to view. A fitted axis may have moved
		// meanwhile (a shared axis zoomed from another chart), and the fit
		// effects do not run off screen. If the mark came back stale, its
		// catch-up result refits like any data change (#refitFromData, or
		// #onTooltipTableWritten with JS transforms). Refitting here as well
		// would fit to the old data first, then to the new: two fits.
		// Otherwise its data is current and nothing else will refit, so
		// refit now.
		$effect(() => {
			const handle = this.#handle;
			const visible = this.#chartContext.visible ?? true;
			if (!handle) return;
			untrack(() => {
				const cameBack = visible && !handle.active;
				const caughtUp = handle.setActive(visible);
				if (!visible) this.#snapFitVersion = null;
				if (cameBack && !caughtUp) this.#refitOnReturn();
			});
		});

		// Push per-mark params and trigger query. Runs immediately after
		// registration (Svelte flushes effects in creation order), providing
		// the initial query. On subsequent changes to sort/limit,
		// or to a transform parameter given as a getter, re-queries this mark
		// only via _onParamsChange.
		//
		// `sort` is not read by the engine: the rank transform reads it when the
		// query is assembled. It is here so that changing it re-queries, which
		// is where the new ranking comes from.
		$effect(() => {
			if (!this.#handle) return;
			const sort = this.#reactiveConfig.sort;
			const limit = this.#reactiveConfig.limit;
			// Read for tracking only: transforms read their parameters when the query
			// is assembled, so a changed count needs a re-query and not a rebuild.
			void this.#transformCompiler.specs;
			untrack(() => {
				// A mark sorted at any point takes its band axis from the data from
				// then on; see the field.
				if (this.#rankingSort) this.#bandDomainFromData = true;
				this.#handle!.updateParams({ sort, limit });
			});
		});

		// Domain registration: when data arrives, register data-derived domains.
		$effect(() => {
			if (!this.setupComplete) return;
			const dv = this.dataVersion;
			if (dv === 0) return;

			untrack(() => {
				this.#handleDataDomains(dv);
				this.otherRows.register();
				// After the domains: the last release opens the gate, and the
				// scales snap to every mark's extent only until then.
				this.#releaseEntrance();
			});
		});

		// A failed query has nothing to enter with; it must not hold the chart.
		$effect(() => {
			if (this.#handle?.error) untrack(() => this.#releaseEntrance());
		});

		// Tooltip: two effects, so a data update does not take the table away.
		//
		// This one owns the table's lifetime: it drops it when tooltips go from
		// wanted to not. It used to be one effect with the write below, and its
		// cleanup then ran on every data update too: the table was dropped and
		// marked not ready, the mark's tooltip unregistered, and the hovered row
		// went with it. A click right after a data update found no row under the
		// pointer, read as a click on empty space and cleared the selection, and
		// the next click did nothing until the pointer moved.
		// A path mark's layout is checked on every result, whether or not its
		// renderer reads it, and a refusal reported: once per reason, not per
		// result, which a brush would repeat every frame.
		$effect(() => {
			if (!this.#config._rowLayouts) return;
			const layout = this.rowLayout;
			const why = layout.kind === 'refused' ? layout.why : null;
			if (why !== null && why !== this.#refusedLayout) {
				console.error(
					`fjader: ${this.#markId} draws nothing: ${why}. Its rows cannot be joined into ` +
						'lines or areas as they are.'
				);
			}
			this.#refusedLayout = why;
		});

		$effect(() => {
			const tooltipConfig = this.#reactiveConfig.tooltip;
			const fitDomain = this.#reactiveConfig.fitDomain;
			if (tooltipConfig === false && !fitDomain) return;
			return () => {
				clearTimeout(this.#tooltipWriteTimeout!);
				this.#tooltipTableReady = false;
				this.#dropTooltipTable();
			};
		});

		// And this one rewrites it when data updates, but only when someone may
		// hover it. The table is a second scan of the mark's data, often with a
		// sort, and nobody hovers most charts after most changes (at load, or
		// while another chart is brushed), so a write per data change was the
		// largest cost after a table load.
		//
		// - The chart hovered: written after the data settles (debounced), as
		//   before. The old table stays readable until the rewrite replaces it,
		//   so a click right after a data update still finds its row.
		// - Not hovered: the table is marked stale (not ready), which takes the
		//   mark out of the tooltip manager, so no lookup reads old rows. It is
		//   written when the pointer enters the chart, at once, as interaction:
		//   it is what the first hover waits for.
		// - A pan or zoom under way on the chart (ChartHover.gesturing): not
		//   written. No tooltip shows and no click lands while it lasts, and each
		//   rebin or moved window would rewrite it. The old table stays readable,
		//   as during the debounce; it is written at once when the gesture ends.
		// - fitDomain on a mark with JS transforms reads the table to fit
		//   (#buildFitDomainQuery), so that mark writes eagerly, in background,
		//   gesture or not.
		$effect(() => {
			const tooltipConfig = this.#reactiveConfig.tooltip;
			const fitDomain = this.#reactiveConfig.fitDomain;
			if (tooltipConfig === false && !fitDomain) return;

			const dataVersion = this.dataVersion;
			if (dataVersion === 0) return;
			const hovered = this.#chartContext.hovered ?? true;
			const gesturing = this.#chartContext.gesturing ?? false;
			const eager = !!fitDomain && this.#transformCompiler.hasJSTransforms();

			untrack(() => {
				// The run where a gesture ends, before anything returns early.
				const gestureEnded = this.#tooltipGesturing && !gesturing;
				this.#tooltipGesturing = gesturing;
				if (dataVersion === this.#tooltipWrittenFor) return;
				clearTimeout(this.#tooltipWriteTimeout!);
				// A data change waits for the data to settle; hover arriving at a
				// stale table writes at once.
				const dataChanged = dataVersion !== this.#tooltipSeenVersion;
				this.#tooltipSeenVersion = dataVersion;
				if (!hovered && !eager) {
					this.#tooltipTableReady = false;
					return;
				}
				// Waits for the gesture's end, which re-runs this effect: the version
				// is seen by then, so it writes at once. Meanwhile the mark is out of
				// the tooltip manager, as when not hovered: its table holds the rows
				// from before the gesture, and a tooltip must not read them over the
				// new ones. Back in when the write lands (#writeTooltipTable), however
				// long it waits for a query in flight.
				if (gesturing && !eager) {
					this.#tooltipTableReady = false;
					return;
				}
				const cls = eager && !hovered ? 'background' : 'interaction';
				const write = () => {
					const data = this.data;
					if (!data || data.length === 0) return;
					this.#tooltipWrittenFor = dataVersion;
					this.#writeTooltipTable(data, cls);
				};
				// Sent from this effect, not a timer, so it goes out before a preagg
				// build the same pointer enter queues (see Preagg.activate).
				// A catch-up result is one result, with nothing to settle. At a
				// gesture's end, a query still in flight (its last rebin or window
				// move) is about to replace these rows: debounced too, so its result
				// restarts the wait and one write follows; a superseded one lets the
				// timer write. Only then: a hover arriving while another chart is
				// brushed (a query in flight here too) writes at once, as before.
				const catchUp = this.#handle?.resultCause === 'catchUp';
				const settling = gestureEnded && (this.#handle?.queriesInFlight ?? 0) > 0;
				if ((dataChanged || settling) && !catchUp) {
					this.#tooltipWriteTimeout = setTimeout(write, SETTLE_MS);
				} else write();
			});
			return () => clearTimeout(this.#tooltipWriteTimeout!);
		});

		// fitDomain after a data change (a brush on another chart, the first
		// result): refit, debounced like the data settling. Marks with JS
		// transforms refit after their tooltip table is written instead, which
		// their fit reads (#onTooltipTableWritten). Off screen, like the mark's
		// re-queries: the return to view refits (#refitOnReturn).
		$effect(() => {
			const fitDomain = this.#reactiveConfig.fitDomain;
			if (!fitDomain) return;
			const dataVersion = this.dataVersion;
			if (dataVersion === 0) return;
			// Untracked: a return to view refits from the setActive effect, which
			// knows whether a catch-up result is coming.
			if (!untrack(() => this.#chartContext.visible ?? true)) return;
			// A catch-up result's fit snaps, and has no data to wait for.
			const catchUp = untrack(() => this.#handle?.resultCause === 'catchUp');
			this.#snapFitVersion = catchUp ? dataVersion : null;
			// With JS transforms the fit reads the tooltip table, and a data change
			// refits after its write (#onTooltipTableWritten).
			if (this.#transformCompiler.hasJSTransforms()) return;
			untrack(() => {
				clearTimeout(this.#refitTimeout!);
				if (catchUp) this.#refitFromData();
				else this.#refitTimeout = setTimeout(() => this.#refitFromData(), 300);
			});
			return () => clearTimeout(this.#refitTimeout!);
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

			// Off screen, like the mark's re-queries (MarkHandle.active): no fit.
			// Read untracked: the return to view fits once (#refitOnReturn, or
			// the catch-up result), at the driving axis's domain then; tracking
			// it here too sent a second fit for the same return. Checked only
			// AFTER the driving domain is read: an effect re-runs on what its last
			// run read, so returning before that left the effect deaf to the
			// driving axis after any run off screen, and brushes made once the
			// chart was back on screen sent no fit at all.
			if (!untrack(() => this.#chartContext.visible ?? true)) return;

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
				// The driving axis moved: whatever fit follows is that zoom's, and
				// springs.
				this.#snapFitVersion = null;
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

	/** Bumped by each setup run that queries; see #runSetup. */
	#setupGeneration = 0;
	/** The scales the latest querying setup run started with, while it is in flight. */
	#setupInFlight: readonly unknown[] | null = null;

	async #runSetup(colorReady: boolean, inputs: readonly unknown[]): Promise<void> {
		if (this.#destroyed) return;

		// Wait for the colour scale — and the series scale, which takes a dim the
		// same way — before completing setup.
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

		// The setup effect re-enters whenever a scale it reads settles, and an
		// earlier run may still be awaiting its queries. Only the latest run
		// may finish: a superseded one stops after its await, so it cannot
		// register domains on a scale that has since been replaced, nor set
		// setupComplete from stale scale state. Its queries are already sent.
		const generation = ++this.#setupGeneration;
		const superseded = () => this.#destroyed || generation !== this.#setupGeneration;
		this.#setupInFlight = inputs;
		try {
			await this.#runSetupQueries(superseded);
		} finally {
			if (generation === this.#setupGeneration) this.#setupInFlight = null;
		}
	}

	/** The querying part of #runSetup; `superseded` says a later run has started. */
	async #runSetupQueries(superseded: () => boolean): Promise<void> {
		// Passive scales: skip domain fetching but still need schema for CAST decisions
		if (this.#config.passiveScales) {
			const columns = await this.#queryEngine.describe(this.#config.table);
			if (superseded()) return;
			this.#schema = buildSchemaMap(columns);
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
			if (this.#transformCompiler.hasCategoryReducingTransforms() || this.#rankingSort) {
				this.#bandDomainFromData = true;
			}

			// Batch all domain queries + schema fetch in parallel
			const [schemaColumns, fetchCount, aggResult, fieldStats] = await Promise.all([
				// Fetch table schema (cached on QueryEngine, needed for CAST type decisions)
				this.#queryEngine.describe(this.#config.table),
				fetchCategoricalDomains(
					this.#queryEngine,
					this.#config.table,
					this.#config.select,
					this.actualXScaleType,
					this.actualYScaleType,
					this.#bandScaleForDomain('x'),
					this.#bandScaleForDomain('y'),
					this.#chartContext.facetBandScale,
					this.#chartContext.fx,
					this.#config.colorChannel || 'fill',
					this.#colorScaleState,
					this.#config.sizeChannel || 'r',
					this.#sizeScaleState,
					this.#seriesScaleState,
					seriesKey,
					this.#bandDomainFromData,
					this.#markId,
					this.#placeExtent,
					this.#reactiveConfig.domain,
					this.#reactiveConfig.nulls === 'drop',
					superseded
				),
				fetchGlobalAggregates(
					this.#queryEngine,
					this.#config.table,
					this.#config.select,
					this.#channelsNeedingDataDomain,
					this.#autoBinNodes.size,
					this.#buildQueryForAggregates.bind(this),
					this.#config,
					this.#chartContext.xScaleState as ContinuousScaleState | null,
					this.#chartContext.yScaleState as ContinuousScaleState | null,
					this.#colorScaleState,
					this.#markId,
					this.#placeExtent,
					superseded
				),
				this.#fetchFieldStats(),
				this.#ensureIdentityColumns()
			]);

			if (superseded()) return;

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
					this.#markId,
					this.#placeExtent,
					this.#placeColumnExtent
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
			this.#releaseEntrance();
		}
	}

	/** The chart's entrance gate, or null outside a chart (tests). */
	#entranceGate: EntranceGate | null = null;

	/** Stop holding the chart's entrance. Idempotent: the gate ignores a second. */
	#releaseEntrance(): void {
		this.#entranceGate?.release(this.#markId);
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

		// Series. A separate `z` channel takes its dim's id column like colour
		// does; the renderer only compares neighbouring rows for equality, and
		// ids compare exactly as values did.
		const seriesChannel = this.#config._orderConfig?.seriesChannel ?? null;
		const seriesField =
			seriesChannel && seriesChannel !== colorChannel
				? identityKeyFor(this.#config.select[seriesChannel])?.key
				: null;
		if (seriesChannel && seriesField && this.#identityFields.has(seriesField)) {
			select[seriesChannel] = castReal(sqlColumn(this.#queryEngine.identityColumn(seriesField)));
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
	 * Rewrite a time axis's channels as seconds from the scale's origin t0, which
	 * the GPU draws in float32. Handles base channel + extent variants (x1/x2,
	 * y1/y2: a range, or bin expansion).
	 */
	#inlineTimeOffsets(select: Record<string, unknown>): void {
		for (const [axis, channels] of [
			['x', ['x', 'x1', 'x2']],
			['y', ['y', 'y1', 'y2']]
		] as const) {
			const t0Epoch = this.#timeOrigin(axis);
			if (t0Epoch === null) continue;

			// The scale gives the origin; each channel keeps its own column. A
			// range's x1 and x2, or two marks on different date columns, share an
			// axis but not their values.
			for (const ch of channels) {
				if (!(ch in select)) continue;
				const val = select[ch];
				const expr = typeof val === 'string' ? sqlColumn(val) : isNode(val) ? val : null;
				if (expr) select[ch] = sql`CAST((epoch(${expr}) - ${t0Epoch}) AS REAL)`;
			}
		}
	}

	/**
	 * The time axis's origin in epoch seconds, which its channels are drawn
	 * relative to, or null when the axis is not a time scale or has no origin
	 * yet. Its channels are rewritten, and its time buckets padded, only with one.
	 */
	#timeOrigin(axis: 'x' | 'y'): number | null {
		const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
		if (scaleType !== 'time') return null;
		const scaleState = this.#chartContext[`${axis}ScaleState`] as TimeScaleState | null;
		if (!scaleState?.t0) return null;
		return Math.floor(scaleState.t0.getTime() / 1000);
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
		// `time`: on a time axis, so read raw (epoch ms) even when the schema
		// can't name it, as for an expression.
		const fields: { key: string; expr: unknown; time?: boolean }[] = [];

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
				if (!isContinuousScale(scaleType)) continue;
				if (isNode(expr) && isAggregateExpression(expr)) continue;
				if (isNode(expr) && isWindowExpression(expr)) continue;
				fields.push({ key, expr, time: isTemporalScale(scaleType) });
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
		// Numeric fields get CAST to REAL. Date/timestamp fields, and any field
		// on a time axis, are left uncast; their values are taken as epoch ms.
		// describe() is cached on QueryEngine, so this await is free if
		// it's already running in parallel from the same Promise.all.
		const schema = buildSchemaMap(await this.#queryEngine.describe(this.#config.table));
		const selectDef: Record<string, unknown> = {};
		for (let i = 0; i < unique.length; i++) {
			const colExpr = isNode(unique[i].expr) ? unique[i].expr : sqlColumn(String(unique[i].expr));
			const colName = String(unique[i].expr).replace(/^["']|["']$/g, '');
			const jsType = schema?.get(colName)?.jsType;
			if (jsType === 'date' || unique[i].time) {
				// Date columns: raw MIN/MAX, convert to epoch ms in JS
				selectDef[`min_${i}`] = min(colExpr as ExprValue);
				selectDef[`max_${i}`] = max(colExpr as ExprValue);
			} else {
				selectDef[`min_${i}`] = cast(min(colExpr as ExprValue), 'REAL');
				selectDef[`max_${i}`] = cast(max(colExpr as ExprValue), 'REAL');
			}
		}

		const q = Query.from(this.#config.table).select(selectDef as Record<string, ExprValue>);
		// Shared and cached: marks on one table ask the same ranges (see QueryOpts.cache).
		const result = await this.#queryEngine.query(q, { cache: true, source: this.#config.table });
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

		const data = this.data;
		// Taken from every result, so the step compared with is the last drawn.
		const rebin = !!data && this.#takeBinStep();

		// Once domains are derived from the first query result, skip
		// re-registration on subsequent results (e.g., crossfilter updates).
		// Exceptions: a band axis the data decides is re-derived on every result,
		// and a rebin result changes the unit of the value axis.
		if (this.#dataDerivedDomainsSet && !rebin) {
			if (this.#bandDomainFromData && dv !== this.#lastBandDomainDataVersion) {
				this.#lastBandDomainDataVersion = dv;
			} else {
				return;
			}
		}

		if (data) {
			const additionalChannels = this.#transformCompiler.getAdditionalChannels();
			let xState = this.#chartContext.xScaleState as ContinuousScaleState | null;
			let yState = this.#chartContext.yScaleState as ContinuousScaleState | null;
			let skipAxis = this.#skipDomainUpdateForAxis;
			let instantFor = this.#instantFor;

			// A path's result over a window re-registers its series or ordinal colour
			// only (a topN or sort re-reads them from every result), never a
			// continuous scale: the window's rows would narrow it to what the window
			// holds. Without a window it re-registers as it did before windows.
			// Following the bins on y is the rebin ride's, for every path at once.
			let colorState = this.#colorScaleState;
			if (this.#dataDerivedDomainsSet && this.#config._rowLayouts && this.#handle?.resultWindow) {
				xState = null;
				yState = null;
				if (!colorState?.isOrdinal) colorState = null;
			}

			// A rebin result: the value axis (count per bucket) changed unit, so
			// it registers once, at once where nothing else would jump. Never the
			// binned axis: the user's zoom set it, whichever result reset the skip.
			const binnedAxis = rebin ? this.#binnedAxis() : null;
			const valueAxis = binnedAxis === 'x' ? 'y' : binnedAxis === 'y' ? 'x' : null;
			const valueState = valueAxis === 'x' ? xState : valueAxis === 'y' ? yState : null;
			let fitted = false;
			let fit: [number, number] | null | undefined = undefined;
			let drivingTarget: [number, number] | null = null;
			let tweens = false;
			if (binnedAxis && valueAxis && valueState) {
				skipAxis = binnedAxis;
				const fitDomain = this.#reactiveConfig.fitDomain;
				fitted =
					!!fitDomain &&
					!this.#fitDomainSuppressed &&
					this.#resolveFittedAxis(fitDomain) === valueAxis;
				if (fitted) {
					const binnedState =
						binnedAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
					const target = (binnedState as ContinuousScaleState | null)?.domain?.target;
					drivingTarget = target ? [target[0], target[1]] : null;
					fit = this.#fitFromResult(valueAxis, drivingTarget);
					// A fitted value axis is registered by its fit alone. The whole
					// result's extent is not the window's (zoomed into a quiet stretch
					// it is the burst's), and two registrations under one id would
					// race to the scale.
					if (valueAxis === 'x') xState = null;
					else yState = null;
				}
				// Tweened only with the fit in hand: a fit that must be queried
				// lands later, and springs like any other. A catch-up does not
				// tween: its bars land at once, and the axis lands with them.
				tweens =
					(!fitted || fit !== undefined) &&
					rebinTweens(valueState.userDriven, this.#handle?.resultCause === 'catchUp');
				const catchUp = this.#instantFor;
				if (tweens) instantFor = (scale) => scale === valueState || catchUp(scale);
			}

			let domainResult!: ReturnType<typeof registerDataDerivedDomains>;
			const register = () => {
				domainResult = registerDataDerivedDomains(
					data,
					this.#channelsNeedingDataDomain,
					additionalChannels,
					skipAxis,
					this.#config.zeroBaseline,
					this.actualXScaleType,
					this.actualYScaleType,
					xState,
					yState,
					this.#bandDomainFromData,
					this.#bandScaleForDomain('x'),
					this.#bandScaleForDomain('y'),
					this.#markId,
					this.#placeExtent,
					instantFor,
					colorState,
					this.#transformCompiler.hasCategoryReducingTransforms()
				);
			};
			// A change of unit: inside `discrete()` the value axis tweens its
			// render domain (every consumer glides linearly in pixels), and the
			// rebinning bars resolve in pixel space from the remap, so they hold
			// their height while it does.
			if (tweens && valueState) valueState.discrete(register);
			else register();
			this.#dataDerivedDomainsSet = domainResult.dataDerivedDomainsSet;
			this.#skipDomainUpdateForAxis = domainResult.skipDomainUpdateForAxis;

			if (fitted && valueAxis && valueState) {
				// The fit for this version is taken: drop a SQL fit still in flight
				// (it is at the old bin step), skip this version's debounced refit,
				// and let the driving-axis fit dedupe against this window.
				++this.#fitDomainQuerySequence;
				if (drivingTarget) this.#fitDomainLastTarget = drivingTarget;
				if (fit !== undefined) {
					this.#fittedVersion = dv;
					if (fit) {
						// A change of unit, as the registration above.
						const apply = () =>
							this.#applyFit(valueAxis, fit, drivingTarget, tweens || this.#instantFor(valueState));
						if (tweens) valueState.discrete(apply);
						else apply();
					}
				} else if (!this.#transformCompiler.hasJSTransforms()) {
					// The result cannot answer (its rows are not the dense layout, as
					// past the dense row limit): ask the database now, not after the
					// refit's debounce, since nothing registered the new unit.
					this.#fittedVersion = dv;
					const snap = this.#handle?.resultCause === 'catchUp';
					void this.#issueFitDomainQuery(valueAxis, drivingTarget, true, snap);
				}
				// With JS transforms the fit reads the tooltip table, written after
				// this result: its write refits (#onTooltipTableWritten).
			}

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
	 * Request identity id columns for this mark's categorical axes.
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

		// Series — a line's `z`. When no `z` is given the series channel IS the
		// colour channel and is covered above; only a separate channel takes a
		// dim of its own. Always ordinal: grouping is by category.
		const seriesChannel = this.#config._orderConfig?.seriesChannel ?? null;
		const seriesKey =
			seriesChannel && seriesChannel !== colorChannel
				? identityKeyFor(this.#config.select[seriesChannel])
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

		if (seriesChannel && seriesChannel !== colorChannel && !seriesKey) {
			console.error(
				`[${this.#markId}] The series channel cannot be given a stable identity: group by ` +
					`a column or a fixed expression, not an aggregate, a window or bin(). This mark ` +
					`will render as one series.`
			);
		}

		if (axes.length === 0 && !facetKey && !colorKey && !seriesKey) return;

		const categorical = [...axes.map(({ key, sql }) => ({ key, sql }))];
		for (const extra of [facetKey, colorKey, seriesKey]) {
			if (extra && !categorical.some((c) => c.key === extra.key)) categorical.push(extra);
		}

		// Fatal, unlike at C0: the query now selects these columns and reads FROM
		// the view. Failing here gives a message naming the mark and the fields;
		// continuing would fail at the binder with neither.
		await this.#queryEngine.ensureColumns(this.#config.table, { categorical });
		// Torn down while the dims were built: the scales below may have been
		// dropped with a ChartScales the chart has since replaced. Only a
		// destroyed lifecycle, not a superseded setup run: identity goes to the
		// scales read live from the chart context, so a live run handing it
		// over is harmless.
		if (this.#destroyed) return;
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
			const present = this.#queryEngine.presentTableFor(key, this.#config.table);
			// nulls="drop": its rows are filtered out, and dense() must not pad a
			// zero row for it either, or a sorted axis keeps a "(null)" slot.
			const nullId =
				this.#reactiveConfig.nulls === 'drop' ? this.#queryEngine.identityFor(key).nullId : null;
			identity[channel] = {
				dim: this.#queryEngine.dimTableFor(key),
				size: this.#queryEngine.identityFor(key).values.length,
				positional,
				...(present ? { present } : {}),
				...(nullId !== null ? { dropNullId: nullId } : {})
			};
		};
		for (const { axis, key } of axes) describe(axis, key, true);
		if (colorKey && this.#identityFields.has(colorKey.key)) {
			describe(this.#config.colorChannel || 'fill', colorKey.key, false);
		}
		if (seriesChannel && seriesKey && this.#identityFields.has(seriesKey.key)) {
			describe(seriesChannel, seriesKey.key, false);
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
		// And the series scale, whose channel now carries ids as well. Sharing a
		// field with colour is the registry's business: the two are then one
		// instance, and the adoption above already covered it.
		if (seriesKey) {
			this.#seriesScaleState?.setIdentity(this.#queryEngine.identityFor(seriesKey.key));
		}

		// The synthetic "Other" bucket has no row in any table, so its id has to
		// be reserved before a transform can write it. Reserved for every
		// categorical field of this mark rather than guessing which axis topN
		// will pick — at most two, and the transform looks its own field up.
		const otherScales = new Set<BandScaleState>();
		if (this.#transformCompiler.hasSyntheticOtherBucket()) {
			const otherIds: Partial<Record<'x' | 'y', number>> = {};
			for (const { axis, key } of axes) {
				const scale = (
					axis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState
				) as BandScaleState | null;
				// Always there by now: `axes` holds only axes whose resolved type is
				// band or point, and ChartScales resolves the scale instance eagerly
				// from registerScaleType, in this mark's constructor, so the scale
				// exists before setup runs. The guard is for the type, not a case.
				if (!scale) continue;
				// One Other per band scale, shared by every mark on it (see
				// retainOther). The scale also takes it as its Other id, so an
				// entrance can come out of Other and an exit go into it rather than
				// past the end of the axis.
				//
				// Held on EVERY categorical axis rather than re-deriving which axis
				// topN picked — that derivation living in two places is what silently
				// dropped the Other row once already. The axes topN did not pick are
				// unaffected: their id is on no row, so it is never displayed.
				otherScales.add(scale);
				this.#otherScales.add(scale);
				const other = await scale.retainOther(this.#markId, () =>
					this.#queryEngine.acquireSyntheticIdentity(key, 'Other')
				);
				otherIds[axis] = other.id;

				// Re-adopt: acquiring may have appended to the value array, and a
				// scale that adopted before it must see the new entry.
				scale.setIdentity(this.#queryEngine.identityFor(key));
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
		// Scales this mark no longer draws an Other on (its axis or transform
		// changed) get their claim back.
		for (const scale of this.#otherScales) {
			if (!otherScales.has(scale)) this.#releaseOther(scale);
		}
	}

	#warnedFollow = false;

	/**
	 * Whether this mark follows its band axes instead of adding its categories to
	 * them (`contributeDomain={false}`). It cannot also choose its own categories
	 * or their order: a topN or a ranking would be what a follower exists not to
	 * do, and an explicit domain is a contribution. Such a mark is refused, once,
	 * and contributes as usual.
	 */
	get #followsDomain(): boolean {
		if (this.#reactiveConfig.contributeDomain !== false) return false;
		const reason = this.#transformCompiler.hasCategoryReducingTransforms()
			? 'a category-reducing transform (topN)'
			: this.#rankingSort
				? 'a sort'
				: this.#reactiveConfig.domain
					? 'an explicit domain'
					: null;
		if (!reason) return true;
		if (!this.#warnedFollow) {
			this.#warnedFollow = true;
			console.error(
				`[${this.#markId}] Unsupported: contributeDomain={false} with ${reason}. A mark that ` +
					`follows its band axis cannot choose its own categories or their order. It will ` +
					`contribute to the domain as usual.`
			);
		}
		return false;
	}

	/**
	 * The band scale of an axis, for registering this mark's categories on it:
	 * null for a mark that follows, so it registers nothing and withdraws what it
	 * had (the prop can change). The scale still draws the mark's rows, only those
	 * of categories it shows.
	 */
	#bandScaleForDomain(axis: 'x' | 'y'): BandScaleState | null {
		const scale = (
			axis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState
		) as BandScaleState | null;
		// Only a band or point axis has categories to follow; a value axis is
		// the mark's own.
		const type = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
		if ((type !== 'band' && type !== 'point') || !this.#followsDomain) return scale;
		scale?.removeMark(this.#markId);
		return null;
	}

	/** What this mark's Other rows hold, and what is done with it. */
	readonly otherRows: OtherRows;

	/** What the mark is, for whether its Other bar splits; null before setup completes. */
	get #splitPlan(): SplitPlan | null {
		if (!this.setupComplete) return null;
		const markType = this.#transformConfig.markType;
		const length = markType === 'barx' ? this.#transformConfig.x : this.#transformConfig.y;
		return {
			markType,
			length,
			by: this.#transformCompiler.otherBy(),
			expr: length ? this.#config.select[length] : undefined,
			hasOther: this.#transformCompiler.hasSyntheticOtherBucket(),
			hasJsTransforms: this.#transformCompiler.jsTransforms.length > 0
		};
	}

	/** The band scales whose Other bucket this mark holds a claim on. */
	#otherScales = new Set<BandScaleState>();

	#releaseOther(scale: BandScaleState): void {
		this.#otherScales.delete(scale);
		scale.releaseOther(this.#markId, (other) => this.#queryEngine.releaseSyntheticIdentity(other));
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
	 * A histogram's binned axis aligns too: one row per bin, in bin order. Its
	 * channels are bin edges rather than ids, still never mixed, and with no
	 * slot clock on a linear scale the mark's channels run on a clock of their
	 * own.
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
		const aligned = this.#transformCompiler.alignment(Object.keys(parts.selectDef), {
			groupKeys: parts.groupKeys,
			bins: parts.bins ?? null,
			// The window the queries are sent with: past the whole extent's row
			// limit, only a window pads.
			binWindow: this.#handle?.params.binWindow ?? null
		})?.[0];
		// A band is `x` or `y`; a binned axis aligns on its lower edge, `x1`.
		const axis = aligned?.[0];
		return axis === 'x' || axis === 'y' ? axis : null;
	});

	/**
	 * Build a query for fetchGlobalAggregates.
	 * Standalone assembly — doesn't depend on #resolvedQueryParts
	 * (which isn't available yet during Phase 1 setup).
	 */
	#buildQueryForAggregates(_table: string, _config: unknown, filter: unknown[]): Query | null {
		// Build raw query parts directly from config.select (no identity columns,
		// no bin resolution — scale states aren't ready yet during Phase 1).
		const parts = buildQueryParts(
			this.#config.select,
			this.#config._orderConfig ?? null,
			this.#transformCompiler.hasSQLTransforms()
		);
		// Domains from the rows the mark draws: without what nulls="drop" leaves
		// out. This select is raw, so the filter is on the raw values.
		const q = assembleQuery({
			table: this.#config.table,
			parts,
			filter: [...filter, ...this.#rawNullFilters(this.#config.select)],
			transformCompiler: this.#transformCompiler
		});
		if (!q) return null;
		return Query.from(sql`(${q.toString()})`).select('*');
	}

	// ===========================================================================
	// PUBLIC API (consumed by mark components)
	// ===========================================================================

	/**
	 * The mark's query for the rows on screen: the parts, bin window and
	 * selection filter of the result it holds (before its first, the current
	 * ones), with the window's source filter the engine adds
	 * (windowSourceFilter). What the tooltip table is written from, the
	 * viewport count wraps and the SQL fit reads: each describes the data
	 * drawn, so not a window set since, whose bins may be others. Without a
	 * window, a mark whose bins are sized for one (a path, #maxBins) would pad
	 * the whole extent past the row limit, and get unpadded rows.
	 *
	 * Not the engine's assembly in every respect: it does not split window
	 * aggregates into the engine's CTE or apply its numeric cast, so for a
	 * rolling mean the SQL can differ from what the engine sends. Null before
	 * setup completes (scale domains and time offsets aren't available yet).
	 *
	 * `current`: the current parts, window and filter instead, for the SQL fit,
	 * which answers for the view as it is: it takes over from the held result
	 * exactly when the view has moved past that result's window
	 * (#fitFromResult), and the current window is placed around the view.
	 */
	buildQuery(opts: { current?: boolean } = {}): string | null {
		const handle = this.#handle;
		const held = opts.current ? null : (handle?.resultParts ?? null);
		const parts = held ?? this.#resolvedQueryParts;
		if (!this.setupComplete || !parts) return null;
		// The filter too: a newer query in flight has another one.
		const filter = (
			held
				? (handle?.resultFilter ?? [])
				: (this.#filterGroup.selection.predicate(this.#route) ?? [])
		) as unknown[];
		const binWindow = held ? (handle?.resultWindow ?? null) : (handle?.params.binWindow ?? null);
		const range = windowSourceFilter(parts, this.#transformCompiler, binWindow);
		const q = assembleQuery({
			table: this.#sourceTable,
			parts,
			filter: range ? [...filter, range] : filter,
			transformCompiler: this.#transformCompiler,
			limit: this.#reactiveConfig.limit,
			binWindow
		});
		return q ? q.toString() : null;
	}

	/**
	 * The mark's points inside a view, counted from the result it holds: for a
	 * grid, whose rows are every point the mark draws. `'ask'` for any other
	 * layout (raw rows are decimated before they are drawn; the database counts
	 * those, buildViewportCountQuery). `'wait'` for a binned mark before its
	 * first result: its result is a grid unless padding refuses it, which only a
	 * result can say, and asking the database meanwhile is the query this saves.
	 * The same rows the count query would count, without running the mark's
	 * query again to count them.
	 */
	countInView(xLo: number, xHi: number, yLo: number, yHi: number): HeldCount {
		if (this.#autoBinNodes.size > 0 && this.dataVersion === 0) return 'wait';
		const layout = this.rowLayout;
		if (layout.kind !== 'grid') return 'ask';
		// Bins that follow the view, and can still refine: the points the view's
		// LEVEL is resolved for, not the ones in the view this moment. Within a
		// level the points spread by up to a rebin ratio before the next level
		// closes them up, so a count of the moment made the dots come and go with
		// every level. Held at their finest, the bins stop following, and the
		// points are counted as they are: dots then mean the finest bins.
		const nominal = this.#nominalSteps();
		if (nominal !== null && this.binsHeld !== 'finest') return nominal * layout.series;
		const data = this.data;
		const x = data?.getColumn('x') as ArrayLike<number> | null | undefined;
		if (!data || !x) return 'ask';
		const y = (data.getColumn('y') as ArrayLike<number> | null) ?? null;
		return countRowsInView(x, y, xLo, xHi, yLo, yHi);
	}

	/** The steps across the view of the binned axis's bins while they follow it; null when they do not. */
	#nominalSteps(): number | null {
		for (const [channel, node] of this.#autoBinNodes) {
			const { multiplier, minSteps } = this.#binArgs(channel);
			return node.viewSteps(multiplier, minSteps);
		}
		return null;
	}

	/**
	 * Build a viewport count query for DensityHost LOD measurement.
	 * Wraps the mark's query as a subquery and counts rows within the given
	 * viewport bounds; filters on `x`, so only for a mark with one (LineMark).
	 */
	buildViewportCountQuery(xLo: number, xHi: number, yLo: number, yHi: number): string | null {
		const sqlStr = this.buildQuery();
		if (!sqlStr) return null;

		const parts: string[] = [`SELECT COUNT(*) AS cnt FROM (${sqlStr}) AS _vp`];
		const conditions: string[] = [`_vp.x BETWEEN ${xLo} AND ${xHi}`];
		if (isFinite(yLo) && isFinite(yHi)) {
			conditions.push(`_vp.y BETWEEN ${yLo} AND ${yHi}`);
		}
		parts.push(`WHERE ${conditions.join(' AND ')}`);
		return parts.join(' ');
	}

	/**
	 * Which channel carries this mark's measure, for the transforms that rank or
	 * divide by it (transforms/value-axis.ts). From the chart's resolved scale
	 * types, the ones its rows are drawn on, as #categoricalChannels reads them;
	 * the mark's declared requirements until the chart has resolved them.
	 */
	get #valueAxis(): 'x' | 'y' {
		const resolved = this.#chartContext.scaleTypes;
		const declared = this.#config.scaleRequirements;
		return markValueAxis(
			this.#config.markType,
			resolved?.x ?? declared?.x?.type,
			resolved?.y ?? declared?.y?.type
		);
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

	// --- Selection routing ---

	/**
	 * The identity keys of the categorical fields this mark's renderer reads
	 * selection activity for, sorted: its ordinal colour, its band axes and a
	 * line's or area's own `z`, as activity-reads.ts says the renderer reads
	 * them. A categorical selection on one of these dims the mark; on any other
	 * field it filters it.
	 */
	#reads: readonly string[] = $derived.by(() => {
		const renderer = rendererForMark(this.#config.markType);
		if (!renderer) return NO_READS;
		const color = this.#colorScaleState;
		const bandKey = (axis: 'x' | 'y'): string | null => {
			const type = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
			if (type !== 'band' && type !== 'point') return null;
			const band = this.#chartContext[`${axis}ScaleState`] as BandScaleState | null;
			return band?.identityKey ?? null;
		};
		// The series is a field of its own only on a separate channel (`z`);
		// without one, the series channel is the colour channel, read above.
		const seriesChannel = this.#config._orderConfig?.seriesChannel ?? null;
		const ownSeries = !!seriesChannel && seriesChannel !== (this.#config.colorChannel || 'fill');
		return readsForResponse(
			this.#reactiveConfig.selectionResponse,
			readsFor(activityReads(renderer, this.#config.ruleExtent ?? false), {
				color: color?.isOrdinal ? color.identityKey : null,
				x: bandKey('x'),
				y: bandKey('y'),
				series: ownSeries ? (this.#seriesScaleState?.identityKey ?? null) : null
			})
		);
	});

	/** `#reads` as one string, so the registration effect re-runs only on a real change. */
	#readsKey: string = $derived(this.#reads.join('\u001f'));

	/** Built at registration; the engine and every predicate call hold this object. */
	#route: MarkRoute = { reads: NO_READS, chart: null };

	/**
	 * The page-wide index of this mark's filter group. Its renderer stores it in
	 * MarkConstants to read its group's run of each field's activity block.
	 */
	get groupIndex(): number {
		// NO_GROUP for selectionResponse 'filter', which never dims.
		return groupIndexForResponse(this.#reactiveConfig.selectionResponse, this.#filterGroup.index);
	}

	/**
	 * The data version that lands without animating, or 0: a catch-up result
	 * (the chart came back into view stale), a change nobody just made. A
	 * version, not a flag: the cause stays set until the next result, and a
	 * renderer lands only its FIRST write of this version. Later writes of the
	 * same data (an Other split on a click, a JS transform's parameter) are
	 * changes someone just made, and animate. Reactive through `dataVersion`,
	 * which the cause is set with.
	 */
	get landsFor(): number {
		return this.#handle?.resultCause === 'catchUp' ? this.dataVersion : 0;
	}

	/**
	 * Whether a scale's change from the current result lands at once: a
	 * catch-up result, on a scale no other visible chart draws. Asked as the
	 * result is applied, since visibility moves during a scroll.
	 */
	#instantFor = (scale: object): boolean =>
		this.#handle?.resultCause === 'catchUp' && !this.#chartContext.shownElsewhere(scale);

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

		// Getters: a scale is read, and so tracked, only by a transform that uses
		// it (dodge, x's bandwidth; the stacks, none). Read here, both scales were
		// dependencies of every mark with a JS transform, and one animating (a
		// pan, a zoom) reran the transforms every frame with no data changed.
		const chart = this.#chartContext;
		return this.#transformCompiler.applyToData(accessor, this.#transformConfig, {
			get x() {
				return chart.xScale;
			},
			get y() {
				return chart.yScale;
			}
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

	/** The data version the tooltip table was last written for. */
	#tooltipWrittenFor = -1;
	/** The data version the write effect last saw, to tell a data change from a hover. */
	#tooltipSeenVersion = -1;

	async #writeTooltipTable(data: DataAccessor, cls: StatementClass): Promise<void> {
		const tableName = this.#tooltipTableName;
		// Before any statement: a write that fails part way can leave a table.
		this.#tooltipTableWritten = true;
		try {
			if (!this.#transformCompiler.hasJSTransforms()) {
				// Path A: Build a query with original field names (not CAST-wrapped).
				// Uses channel-named aliases so tooltip columns match expectations.
				const tooltipQuery = this.buildQuery();
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

				// ORDER BY x, so a hover lookup's bounding box could skip row groups
				// (zone maps): only when asked (`tooltip: { sortTable: true }`). Since
				// lazy writes the sort is hover latency, and the lookups did not get
				// faster for it. Measured on a scatter, sorted against unsorted:
				// 200k rows, write 41 against 12 ms, lookup median 2.2 against 2.9 ms;
				// 2M rows (17 row groups), write 273 against 70 ms, lookup median 11.3
				// against 11.4 ms, p90 35 against 30 ms. The lookup's box is wide and
				// holds most of the cost on dense data, sorted or not.
				let orderClause = '';
				const tooltipSortTable =
					typeof this.#reactiveConfig.tooltip === 'object' &&
					this.#reactiveConfig.tooltip.sortTable === true;
				if (tooltipSortTable) {
					const orderCol = ['x', 'x1', 'x2'].find((c) => c in selectConfig);
					if (orderCol) orderClause = ` ORDER BY ${orderCol}`;
				}

				// Without Other's member lists: every hover query is `SELECT *` from
				// this table, so lists of up to the field's cardinality would ship on
				// each one. Only those, not every `__dplot_` column as Path B drops:
				// the rest are scalars (the rank, id columns), cheap to keep, and the
				// lists are the only ones whose size grows with the field.
				const withoutMembers = withoutOtherMembers(tooltipQuery);
				// A path's gaps are rows with a NaN positional measure (a mean with no
				// data, the absent series when it is empty): nothing is drawn there,
				// so nothing is there to hover. Left in, a lookup by x alone would find
				// one and show NaN. Only the positional measures: they decide whether
				// a point is drawn, and a drawn point must stay hoverable.
				const measures = this.#transformConfig.gaps
					? measureChannels(selectConfig).filter(isPositionalChannel)
					: [];
				const gapWhere =
					measures.length > 0
						? ` WHERE NOT (${measures.map((c) => `isnan(${ident(c)})`).join(' OR ')})`
						: '';
				// One statement: a hover query never finds the table missing.
				await this.#queryEngine.exec(
					`CREATE OR REPLACE TEMP TABLE "${tableName}" AS SELECT *${replaceClause} FROM (${withoutMembers})${gapWhere}${orderClause}`,
					{ class: cls, connectionLocal: true }
				);
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
						return `${ident(col)} ${sqlType}`;
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

				await this.#queryEngine.exec(
					[
						`DROP TABLE IF EXISTS "${tableName}"`,
						`CREATE TEMP TABLE "${tableName}" (${schemaDef})`,
						`INSERT INTO "${tableName}" VALUES ${valueRows.join(', ')}`
					],
					{ class: cls, connectionLocal: true }
				);
			}

			// Merge tip expression extras (aggregates/windows) via sidecar query.
			const tipExtras = this.#getTipExtras();
			if (Object.keys(tipExtras).length > 0) {
				try {
					await this.#mergeTipExtras(tableName, tipExtras, cls);
				} catch (err) {
					console.warn('Failed to merge tip extras into tooltip table:', err);
				}
			}

			this.#tooltipTableReady = true;
			// The row under a still pointer was read from the old table: read it
			// again, so the tooltip and a click show the new data without a move.
			this.#chartContext.tooltipManager?.refresh();
			this.#onTooltipTableWritten();
		} catch (error) {
			console.error(`Failed to write tooltip table "${tableName}":`, error);
		}
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
	 * GROUP BY as the main query, then rebuilds the temp table with them
	 * (tipExtrasStatement).
	 */
	async #mergeTipExtras(
		tableName: string,
		tipExtras: Record<string, unknown>,
		cls: StatementClass
	): Promise<void> {
		if (!this.#resolvedQueryParts) return;

		const statement = tipExtrasStatement({
			tooltipTable: tableName,
			table: this.#sourceTable,
			parts: this.#resolvedQueryParts,
			tipExtras,
			filter: this.#filterGroup.selection.predicate(this.#route) ?? [],
			transformCompiler: this.#transformCompiler
		});
		if (!statement) return;

		await this.#queryEngine.exec(statement, {
			class: cls,
			connectionLocal: true
		});
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
		return fitChannels(
			axis,
			this.#config.select,
			includeTransformChannels ? this.#transformCompiler.getAdditionalChannels() : []
		);
	}

	/** Whether the fit includes transform-generated channels (stack's y0/y1). */
	#fitIncludesTransformChannels(): boolean {
		// Tied to the transform actually adding channels, not to which query path
		// (tooltip table vs. sidecar-wrapped query) supplies them. A SQL-stage
		// stack has no tooltip table but #buildSidecarQuery still re-assembles
		// the full query (transforms included), so y0/y1 are there either way.
		return this.#transformCompiler.getAdditionalChannels().length > 0;
	}

	async #issueFitDomainQuery(
		fittedAxis: 'x' | 'y',
		drivingDomain: [number, number] | null,
		force: boolean = false,
		/** A return-to-view fit (#snapFitVersion): lands without a spring. */
		snap: boolean = false
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

		// A binned mark fits from the result it holds: the bins it draws, so
		// the fit cannot describe another bin step, and no query is sent.
		const fromResult = this.#fitFromResult(fittedAxis, drivingDomain);
		if (fromResult !== undefined) {
			if (fromResult) {
				this.#applyFit(fittedAxis, fromResult, drivingDomain, this.#fitInstant(fittedAxis, snap));
			}
			return;
		}

		try {
			const q = this.#buildFitDomainQuery(fittedAxis, drivingDomain);
			if (!q) return;

			const result = await this.#queryEngine.query(q.toString(), {
				callerId: `${this.#markId}:fitDomain`,
				cache: false,
				// With JS transforms the fit reads the TEMP tooltip table;
				// otherwise the mark's base table, routed by it.
				connectionLocal: this.#transformCompiler.hasJSTransforms(),
				source: this.#config.table
			});
			if (seq !== this.#fitDomainQuerySequence) return;

			const row = result.get(0) as Record<string, unknown> | undefined;
			const extent = row ? extentFromFitRow(row) : null;
			if (!extent) return;
			this.#applyFit(fittedAxis, extent, drivingDomain, this.#fitInstant(fittedAxis, snap));
		} catch (e) {
			// Silently ignore — query may fail during teardown or table recreation
		}
	}

	/**
	 * Whether a fit lands without a spring: a return-to-view fit, asked as it
	 * lands. A chart in view that shares the axis keeps the spring, and
	 * everything on the axis moves together through it.
	 */
	#fitInstant(fittedAxis: 'x' | 'y', snap: boolean): boolean {
		if (!snap) return false;
		const scaleState =
			fittedAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
		return !!scaleState && !this.#chartContext.shownElsewhere(scaleState);
	}

	/** Register a fit's extent on the fitted axis, and remember the window it was for. */
	#applyFit(
		fittedAxis: 'x' | 'y',
		extent: readonly [number, number],
		drivingDomain: readonly [number, number] | null,
		instant: boolean
	): void {
		const [lo, hi] = withBaseline(extent, !!this.#config.zeroBaseline?.[fittedAxis]);
		const scaleState =
			fittedAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
		const scaleType = fittedAxis === 'x' ? this.actualXScaleType : this.actualYScaleType;
		if (!scaleState || !this.#placeExtent(fittedAxis, scaleState as ContinuousScaleState)) {
			// No scale, or the mark has left its chart.
		} else if (scaleType === 'time' && 'addOffsetExtent' in scaleState) {
			(scaleState as TimeScaleState).addOffsetExtent([lo, hi], this.#markId, { instant });
		} else if ('addMark' in scaleState) {
			(scaleState as ContinuousScaleState).addMark([lo, hi], this.#markId, { instant });
		}
		if (drivingDomain) this.#fitDomainLastTarget = [drivingDomain[0], drivingDomain[1]];
	}

	/**
	 * The fit from the result this mark holds, for a binned mark whose driving
	 * axis is the binned one: the extent over the bins in the window (null if
	 * none has one), read at stride from the validated layout. Undefined when
	 * the result cannot answer — no bins on the driving axis, a JS transform
	 * (its channels are not the query's), or rows not in the dense layout (the
	 * dense cliff, a limit) — and the SQL fit runs instead.
	 */
	#fitFromResult(
		fittedAxis: 'x' | 'y',
		drivingDomain: readonly [number, number] | null
	): [number, number] | null | undefined {
		const drivingAxis = fittedAxis === 'y' ? 'x' : 'y';
		if (this.#binnedAxis() !== drivingAxis) return undefined;
		if (this.#transformCompiler.hasJSTransforms()) return undefined;
		const data = this.data;
		if (!data || data.length === 0) return undefined;
		// A result over a window answers inside it only, the window it was
		// computed over (not the mark's current one: a pan moves that while a
		// query flies). Past it, the fit would see part of the visible bins.
		if (
			drivingDomain &&
			!insideBinWindow(
				this.#handle?.resultWindow,
				viewInBinUnits(drivingDomain, this.#timeOrigin(drivingAxis), this.#viewScratch)
			)
		) {
			return undefined;
		}

		const includeTransform = this.#fitIncludesTransformChannels();
		const edges = windowEdges(this.#getFitDomainChannels(drivingAxis, includeTransform));
		if (!edges || !('lower' in edges)) return undefined;
		const lower = data.getColumn(edges.lower) as ArrayLike<number> | null;
		const upper = data.getColumn(edges.upper) as ArrayLike<number> | null;
		if (!lower || !upper) return undefined;
		const layout = binLayout(lower, data.length);
		if (!layout) return undefined;

		const fitted: ArrayLike<number>[] = [];
		for (const ch of this.#getFitDomainChannels(fittedAxis, includeTransform)) {
			const values = data.getColumn(ch);
			if (values) fitted.push(values as ArrayLike<number>);
		}
		if (fitted.length === 0) return undefined;
		return windowedFit(lower, upper, layout, fitted, drivingDomain);
	}

	/**
	 * This mark's side of a rebin, for its renderer (`RebinSource`). The
	 * renderer asks once per data version, on that version's first write, and
	 * commits when it has written the layout: so a map is always from what is
	 * on the GPU, even when versions in between were never written.
	 */
	readonly rebinSource: RebinSource = {
		dataVersion: () => this.dataVersion,
		takeRebin: (canHold) => this.#takeRebin(canHold),
		commitLayout: () => {
			this.#takenSide = this.#pendingSide;
		},
		layout: () => this.rowLayout
	};

	/**
	 * How the current result's rows are laid out, for a renderer that joins
	 * them into a path (row-layout.ts). Declared by the query: the order its
	 * transforms promised for the parts this result was computed from, as
	 * `#remapSide` reads it; the rows are checked against it at stride.
	 *
	 * A padded result that is not a whole grid is refused: read as runs it
	 * would draw nothing and say nothing. Reported by the constructor's effect.
	 */
	readonly rowLayout: RowLayout = $derived.by(() => {
		const data = this.data;
		const parts = this.#handle?.resultParts;
		if (!data || data.length === 0 || !parts) return RUNS;
		const channels = Object.keys(parts.selectDef);
		const aligned = this.#transformCompiler.alignment(channels, {
			groupKeys: parts.groupKeys,
			bins: parts.bins ?? null,
			// The window this result was computed over, as with its parts.
			binWindow: this.#handle?.resultWindow ?? null
		});
		const declared = rowLayoutOf(
			aligned,
			data.length,
			(channel) => data.getColumn(channel) as ArrayLike<number> | null,
			channels.includes('__facet')
		);
		const readable = this.#config._rowLayouts;
		return readable ? layoutFor(declared, readable, this.#config.markType) : declared;
	});
	/** The reason `rowLayout` last refused, so each is reported once. Plain: not state. */
	#refusedLayout: string | null = null;

	/**
	 * The current result against the rows last committed: a hold when it
	 * merges them into bins that nest them (`#holdMap`), a forward map when it
	 * is any other rebin of them (`buildBinRemap`), else null. Null when the
	 * bins did not change, or the rows on either side are not the dense layout,
	 * or do not correspond (the rebin then snaps).
	 *
	 * While the renderer holds, nothing new is committed, so every result is
	 * taken against the held rows: a filter result or a further nested merge
	 * holds again (a new gather), anything else ends the hold.
	 *
	 * Reads the result's columns at stride (O(B + F·S)) and builds the map in
	 * one pass over both sides' bins: binned data, bounded by the dense row
	 * limit.
	 */
	#takeRebin(canHold: boolean): RebinDecision {
		const side = this.#remapSide();
		const last = this.#takenSide;
		this.#pendingSide = side;
		if (!side || !last) return null;
		// Other bins, or the same bins over a moved window: both stamped on the
		// results, so a pan's window moving while a query flies cannot mislead.
		if (!binRowsMoved(last.binKey, last.window, side.binKey, side.window)) return null;
		const held = this.#holdMap(last, side, canHold);
		if (held instanceof Uint32Array) return { kind: 'hold', map: held };
		if (typeof held === 'object') {
			// The GPU will hold the pieces: they are what the next result maps from.
			this.#pendingSide = {
				...held.side,
				binKey: `cut:${last.binKey}>${side.binKey}`,
				window: last.window
			};
			return { kind: 'cut', cut: held };
		}
		const map = buildBinRemap(last, side);
		return map ? { kind: 'forward', map, why: held } : null;
	}

	/**
	 * The gather for holding `held` through a merge into `next`, or null when
	 * it should not hold:
	 * - not a rebin (the same bins over a moved window: the forward map is
	 *   already exact);
	 * - a catch-up result, which lands at once;
	 * - the bins do not nest (weeks into months straddle): then the held bars
	 *   are cut at the new edges (`buildBinCut`) and the pieces hold;
	 * - the held rows do not cover the view: a zoom out past the window's
	 *   margin would show blank strips until the swap.
	 * Why not, as a string, for the transition log.
	 */
	#holdMap(held: TakenSide, next: TakenSide, canHold: boolean): Uint32Array | BinCut | ForwardWhy {
		if (held.binKey === next.binKey) return 'window';
		// Finer bins: a split, which goes forward by design.
		if (middleBinWidth(next) < middleBinWidth(held)) return 'split';
		if (!canHold) return 'renderer cannot hold';
		if (this.#handle?.resultCause === 'catchUp') return 'catch-up';
		if (!this.#heldCoversView(held, next)) return 'not covered';
		const map = buildBinRemap(next, held, NEST_EPSILON);
		if (map && isNested(map)) return map;
		return buildBinCut(held, next) ?? 'not nested';
	}

	/**
	 * Whether the held rows cover what the new rows draw in the last viewport
	 * on the binned axis (`heldCoversView`). In the scale's units: the bin
	 * edges are what the bars are drawn with. Each side's span is its first
	 * facet's first and last bins, at the series stride.
	 */
	#heldCoversView(held: TakenSide, next: TakenSide): boolean {
		const view = this.#lastView;
		if (!view) return false;
		const h = sideSpan(held);
		const n = sideSpan(next);
		if (!h || !n) return false;
		return heldCoversView(h, n, view, middleBinWidth(next));
	}

	/** The current result as one side of a remap, or null when it is not the dense layout. */
	#remapSide(): TakenSide | null {
		const axis = this.#binnedAxis();
		const data = this.data;
		const parts = this.#handle?.resultParts;
		if (!axis || !data || data.length === 0 || !parts) return null;
		const lower = data.getColumn(`${axis}1`) as ArrayLike<number> | null;
		const upper = data.getColumn(`${axis}2`) as ArrayLike<number> | null;
		if (!lower || !upper) return null;
		const layout = binLayout(lower, data.length);
		if (!layout) return null;
		// The crossed keys, as dense() ordered the rows by them: the series and,
		// faceted, the facet. Their ids are what must match slot for slot.
		const aligned = this.#transformCompiler.alignment(Object.keys(parts.selectDef), {
			groupKeys: parts.groupKeys,
			bins: parts.bins ?? null,
			// The window this result was computed over, as with its parts.
			binWindow: this.#handle?.resultWindow ?? null
		});
		const ids: ArrayLike<number>[] = [];
		for (const channel of aligned?.slice(1) ?? []) {
			const column = data.getColumn(channel) as ArrayLike<number> | null;
			if (!column) return null;
			ids.push(column);
		}
		return {
			lower,
			upper,
			layout,
			ids,
			binKey: parts.binKey ?? null,
			window: this.#handle?.resultWindow ?? null
		};
	}

	/**
	 * Whether the current result is a rebin result: computed from other bins
	 * than the last one (see rebin.ts). A fact of the result rather than a flag
	 * set when the rebin was asked for, which a filter result landing in
	 * between could take. Read from the parts the result was computed from (the
	 * handle's `resultParts`, stamped by the query that produced it), whose
	 * `binKey` was built with them: a string compare per result.
	 */
	#takeBinStep(): boolean {
		if (!this.#binnedAxis()) return false;
		// Not for a path mark yet: its renderers replace a rebin's rows, they do
		// not ride it. The value axis tweening to the new unit under a line
		// already at its new values would show it at the wrong height for the
		// tween's length. The axis re-registers as for any other result.
		if (this.#config._rowLayouts) return false;
		const key = this.#handle?.resultParts?.binKey ?? null;
		const last = this.#lastBinSpec;
		this.#lastBinSpec = key;
		return isRebin(last, key);
	}

	/**
	 * The binned axis, when this mark pads and queries a window around the
	 * viewport there (bin-window.ts). JS transforms are not padded at all.
	 *
	 * - A path mark (a line or an area): always, once its domains are
	 *   registered. Padding its whole extent grows with zoom depth, and a path is
	 *   only right padded. Its value axis is registered from its first result
	 *   and never again (#takeBinStep), so a window cannot change it; the first
	 *   result must cover the whole extent, so no window before it has landed.
	 *   Its curve reads one point past each end of what it draws: the window's
	 *   cut ends are at least half a view off screen, four bins at its fewest
	 *   steps (PATH_MIN_STEPS).
	 * - Any other mark: when it fits its value axis from the visible bins
	 *   (`fitDomain`), so the whole extent is not needed for y. Without one it
	 *   pads its whole extent: its y is re-registered from each rebin's result.
	 */
	#windowedAxis(): 'x' | 'y' | null {
		const axis = this.#binnedAxis();
		if (!axis || this.#transformCompiler.hasJSTransforms()) return null;
		if (this.#config._rowLayouts) {
			return this.#dataDerivedDomainsSet || this.#config.passiveScales ? axis : null;
		}
		const fit = this.#reactiveConfig.fitDomain;
		return fit === true || fit === (axis === 'x' ? 'y' : 'x') ? axis : null;
	}

	/**
	 * Re-bin `axis` at the view `domain`: the window around it first, for a
	 * mark that pads one, then the bins (#lastBinDomain), so the parts change
	 * once and their first query carries the window. The rebin watch's
	 * (AdaptiveBinRung.triggerReBin), and a path's first window (#onViewport).
	 */
	#rebinTo(axis: string, domain: readonly number[]): void {
		if (axis === 'x' || axis === 'y') this.#noteView(axis, [domain[0], domain[1]]);
		// The window around the new view, set before the parts change: the
		// re-registration's first query reads it as it is sent.
		if (this.#windowedAxis() === axis) {
			const scratch = this.#viewScratch;
			scratch[0] = domain[0];
			scratch[1] = domain[1];
			const view = viewInBinUnits(scratch, this.#timeOrigin(axis), scratch);
			const band = this.#windowBand(axis, [domain[0], domain[1]]);
			// A path whose window would hold the whole extent pads it without one:
			// the same bins, and the SQL its first query at these bins had. The
			// same check as #onViewport's, so the two cannot disagree on one view
			// (a first window re-binning on every frame).
			const whole = !!this.#config._rowLayouts && this.#windowCoversField(axis, view);
			this.#handle?.setBinWindow(whole ? null : binWindowFor(view, band), false);
		}
		this.#lastBinDomain[axis] = [domain[0], domain[1]];
		// #lastBinDomain is $state — #resolvedQueryParts recomputes automatically.
		// A mark binned on one axis takes the rebin from the result itself
		// (#takeBinStep), which re-registers its value axis. Clearing the
		// flag here as well armed it for whichever result came next: a
		// filter result re-registered y from the whole extent over the
		// fit, and a rebin that kept its nice step sends no result at all
		// (the same SQL, the same cached table), which left the
		// driving-axis fit gated off until one came. 2D bins keep the
		// reset: a heatmap's continuous colour domain re-registers through it.
		if (this.#binnedAxis() === null) {
			this.#skipDomainUpdateForAxis = axis;
			this.#dataDerivedDomainsSet = false;
		}
	}

	/**
	 * Whether a window around `view` (in the bins' units) would hold the binned
	 * field's whole extent, from its statistics: the bins are planned from the
	 * same min and max. One answer per view, whatever bins are asked about.
	 * Allocates nothing once the field's name is known.
	 */
	#windowCoversField(axis: 'x' | 'y', view: readonly [number, number]): boolean {
		let name = this.#binFieldNames.get(axis);
		if (name === undefined) {
			const node =
				this.#autoBinNodes.get(`${axis}1`) ??
				this.#autoBinNodes.get(`${axis}2`) ??
				this.#autoBinNodes.get(axis);
			if (!node) return false;
			name = typeof node.field === 'string' ? node.field : node.field.toString();
			this.#binFieldNames.set(axis, name);
		}
		const stats = this.#fieldStats?.[name];
		if (!stats) return false;
		return windowCoversRange(view, Number(stats.min), Number(stats.max));
	}
	/** The binned field's name per axis, for #windowCoversField. Plain: fixed per mark. */
	#binFieldNames = new Map<string, string>();

	/**
	 * The bin grid a window set for a view at `domain` is snapped to. A path
	 * mark: the bins it will have there with the window, which its cap counts
	 * (windowPaddedBins assumes the window is snapped to its own bins). Any
	 * other mark: the bins on screen, as the new step's is not resolved yet;
	 * still outward, so the view is covered, and the SQL snaps exactly.
	 */
	#windowBand(axis: 'x' | 'y', domain: [number, number]): BinPadding | undefined {
		const bins = this.#config._rowLayouts
			? this.#binPadding({ axis, domain, padsWindow: true })
			: this.#resolvedQueryParts?.bins;
		return bins?.[`${axis}1`];
	}

	/**
	 * Each frame's viewport on a binned axis (AdaptiveBinRung): moves the
	 * window when it no longer serves the view, and re-queries. A mark that
	 * stops windowing (fitDomain off) goes back to the whole extent.
	 */
	#onViewport(axis: 'x' | 'y', domain: [number, number]): void {
		this.#noteView(axis, domain);
		const handle = this.#handle;
		if (!handle) return;
		const current = handle.params.binWindow ?? null;
		if (this.#windowedAxis() !== axis) {
			if (current) handle.setBinWindow(null, true);
			return;
		}
		// A window set that no query went out with (set quietly for a query that
		// then never came): send it, so the rows on screen are not left behind.
		// First: a window cleared quietly is one too.
		if (current !== handle.sentWindow) {
			handle.setBinWindow(current, true);
			return;
		}
		// A path's first window, once its first result has registered its value
		// axis, and only once the window would leave part of the extent out: one
		// that covers it pads the same bins as none, and its other SQL would miss
		// the cache for the same rows (a second query for every path at load).
		// Checked each frame without allocating.
		//
		// Set as a rebin to the view it is placed around (#rebinTo): the bins may
		// still be planned at an older view, several levels off (the watch moves
		// level without a rebin when the bins come out the same), and the cap the
		// window lifts must be counted at the view the window is around. The
		// parts change once, and their re-registration's query carries it.
		if (!current && this.#config._rowLayouts) {
			if (!this.#resolvedQueryParts?.bins?.[`${axis}1`]) return;
			const view = viewInBinUnits(domain, this.#timeOrigin(axis), this.#viewScratch);
			if (this.#windowCoversField(axis, view)) return;
			this.#rebinTo(axis, domain);
			return;
		}
		const band = this.#resolvedQueryParts?.bins?.[`${axis}1`];
		const view = viewInBinUnits(domain, this.#timeOrigin(axis), this.#viewScratch);
		if (!binWindowNeedsMove(current, view, band ? binExtent(band) : null)) return;
		// A path zoomed out until its window would hold the whole extent drops it,
		// as a rebin there would (#rebinTo): its query meets the whole extent's in
		// the cache, and its bins are capped for the extent again. Not by clearing
		// the window alone, which would send the window's bins unwindowed.
		if (this.#config._rowLayouts && this.#windowCoversField(axis, view)) {
			this.#rebinTo(axis, domain);
			return;
		}
		handle.setBinWindow(binWindowFor(view, band), true);
	}

	/** The viewport on the binned axis, as the rung reads it each frame (no allocation). */
	#noteView(axis: 'x' | 'y', domain: readonly [number, number]): void {
		if (axis !== this.#binnedAxis()) return;
		const view = (this.#lastView ??= [0, 0]);
		view[0] = Math.min(domain[0], domain[1]);
		view[1] = Math.max(domain[0], domain[1]);
	}

	/** The axis a bin() channel is on, when exactly one is; null without bins or with both. */
	#binnedAxis(): 'x' | 'y' | null {
		const x = this.#autoBinNodes.has('x1') || this.#autoBinNodes.has('x2');
		const y = this.#autoBinNodes.has('y1') || this.#autoBinNodes.has('y2');
		return x === y ? null : x ? 'x' : 'y';
	}

	#buildFitDomainQuery(
		fittedAxis: 'x' | 'y',
		drivingDomain: [number, number] | null
	): Query | null {
		const useTooltipTable = this.#transformCompiler.hasJSTransforms() && this.#tooltipTableReady;
		const includeTransformChannels = this.#fitIncludesTransformChannels();

		const fittedChannels = this.#getFitDomainChannels(fittedAxis, includeTransformChannels);
		if (fittedChannels.length === 0) return null;
		const outerSelect = fitSelect(fittedChannels);

		let whereClause: FilterExpr | undefined = undefined;
		if (drivingDomain) {
			const drivingAxis = fittedAxis === 'y' ? 'x' : 'y';
			const drivingChannels = this.#getFitDomainChannels(drivingAxis, includeTransformChannels);
			whereClause = fitWindowWhere(drivingChannels, drivingDomain);
		}

		if (useTooltipTable) {
			const q = Query.from(this.#tooltipTableName).select(outerSelect);
			if (whereClause) q.where(whereClause);
			return q;
		}

		// Path A: CTE-wrap the mark's base query
		return this.#buildSidecarQuery(outerSelect, whereClause);
	}

	/**
	 * Build a sidecar query by wrapping this mark's base query as a derived table.
	 * Used by fitDomain (MIN/MAX) and potentially DensityHost (COUNT).
	 */
	#buildSidecarQuery(outerSelect: Record<string, unknown>, where?: unknown): Query | null {
		// The view as it is, not the rows on screen: see buildQuery.
		const markQuery = this.buildQuery({ current: true });
		if (!markQuery) return null;
		const q = Query.from({ mark_data: sql`(${markQuery})` }).select(
			outerSelect as Record<string, ExprValue>
		);
		if (where) q.where(where as FilterExpr);
		return q;
	}

	/**
	 * A tooltip table was written. A fit over a mark with JS transforms reads that
	 * table (#buildFitDomainQuery), so its refit after a data change waits for
	 * the write; every other fit refits from the data itself (#refitFromData).
	 */
	#onTooltipTableWritten(): void {
		if (this.#transformCompiler.hasJSTransforms()) this.#refitFromData();
	}

	/**
	 * Refit the fitted axis to the mark's current data, at the driving axis's
	 * current domain. The data-driven trigger: the fitDomain effect reacts to the
	 * driving axis, not to new data, and returns for a band driving axis, so this
	 * is also a band-driven fit's only trigger, its first fit included.
	 */
	#refitFromData(): void {
		const fitDomain = this.#reactiveConfig.fitDomain;
		if (!fitDomain) return;
		// Fitted as it landed (#handleDataDomains, a rebin result).
		if (this.dataVersion === this.#fittedVersion) return;
		// The fit for the snap's version, if this is it; a refit for any other
		// version springs, and a skipped one gives the snap up.
		const snap = this.#snapFitVersion !== null && this.#snapFitVersion === this.dataVersion;
		this.#snapFitVersion = null;
		if (this.#fitDomainSuppressed) return;
		if (snap) this.#snapFitVersion = this.dataVersion;

		const fittedAxis = this.#resolveFittedAxis(fitDomain);
		if (!fittedAxis) return;

		const drivingAxis = fittedAxis === 'y' ? 'x' : 'y';
		const drivingSS =
			drivingAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
		if (!drivingSS) return;

		if (drivingSS.scaleType === 'band') {
			this.#issueFitDomainQuery(fittedAxis, null, true, snap);
			return;
		}

		const target = drivingSS.domain?.target;
		if (!target) return;

		this.#issueFitDomainQuery(fittedAxis, target as [number, number], true, snap);
	}

	/**
	 * The chart came back into view with current data: fit to the driving
	 * axis as it is now. Not debounced, since no data is settling. With JS
	 * transforms the fit reads the tooltip table; if its write is still
	 * pending, #onTooltipTableWritten fits after it instead.
	 */
	#refitOnReturn(): void {
		if (!this.#reactiveConfig.fitDomain || this.dataVersion === 0) return;
		this.#snapFitVersion = this.dataVersion;
		if (this.#transformCompiler.hasJSTransforms() && !this.#tooltipTableReady) return;
		clearTimeout(this.#refitTimeout!);
		this.#refitFromData();
	}

	// ===========================================================================
	// CLEANUP
	// ===========================================================================

	destroy(): void {
		this.#destroyed = true;
		// A fit still in flight would land on the mark's extent after its
		// successor's, under the same id: its sequence check now fails.
		++this.#fitDomainQuerySequence;
		// Not releasing the entrance here: a mark rebuilds its lifecycle when
		// its scales resolve, and the rebuilt one re-holds the same id. The
		// mark's unmount releases it (ChartConfig.unregisterMark).
		this.#identityResetOff?.();
		this.#identityResetOff = null;
		this.otherRows.unregister();
		for (const scale of [...this.#otherScales]) this.#releaseOther(scale);
		this.#handle?.destroy();
		clearTimeout(this.#fitDomainTimeout!);
		clearTimeout(this.#refitTimeout!);
		clearTimeout(this.#tooltipWriteTimeout!);

		if (this.#lodRegistered) {
			this.#chartContext.config.unregisterMarkLOD(this.#markId);
			this.#onMarkLOD?.(null);
			this.#onMarkLOD = null;
			this.#lodRegistered = false;
		}
		if (this.#adaptiveBinRung) {
			this.#adaptiveBinRung.destroy();
			this.#adaptiveBinRung = null;
		}

		// Defensive tooltip table cleanup. The tooltip $effect cleanup
		// also drops the table on unmount. This explicit DROP covers the case
		// where destroy() is called synchronously before Svelte processes
		// effect teardown.
		this.#tooltipTableReady = false;
		this.#dropTooltipTable();
	}

	#dropTooltipTable(): void {
		if (!this.#tooltipTableWritten) return;
		this.#tooltipTableWritten = false;
		this.#queryEngine
			.exec(`DROP TABLE IF EXISTS "${this.#tooltipTableName}"`, {
				class: 'background',
				// A TEMP table on the main connection, written and dropped only
				// there, so a drop cannot overtake the next lifecycle's write.
				connectionLocal: true
			})
			.catch(() => {});
	}
}

/** Same scale states and types, compared by identity. */
function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}
