// src/lib/types.ts
//
// Shared type definitions for Fjader.
// This file is the single source of truth for types that cross module boundaries.

import type { ExprNode, SelectQuery } from '@uwdata/mosaic-sql';
import type { DataAccessor } from '$lib/data/DataAccessor';
import type { ChartConfig } from '$lib/config/ChartConfig.svelte';
import type { DimValue } from '$lib/query-engine/categorical-identity';
import type { AutoBinNode } from '$lib/sql/bin';
import type { SelectionResponse } from '$lib/components/rendering/activity-reads';

/** What a mark does with NULL in its categorical channels; see BaseMarkProps.nulls. */
export type NullsResponse = 'keep' | 'drop';
import type { RollingAvgNode } from '$lib/sql/rolling-avg';

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export type ContinuousScaleType = 'linear' | 'log' | 'symlog' | 'pow' | 'identity';
export type DiscreteScaleType = 'band' | 'point';
export type TemporalScaleType = 'time';
export type ScaleType = ContinuousScaleType | DiscreteScaleType | TemporalScaleType;

/** Shared surface implemented by all axis scale state classes (Linear, Band, Time). */
export interface BaseScaleState {
	id: string;
	ready: boolean;
	setReady(): void;
	removeMark(identifier: string): void;
}

/** Minimal callable interface for D3 scales. */
export interface D3Scale {
	(value: unknown): number;
	domain(): unknown[];
	range(): number[];
	invert?(value: number): number;
	ticks?(count?: number): number[];
	tickFormat?(count?: number, specifier?: string): (d: number) => string;
	bandwidth?(): number;
}

/** D3 band scale — adds bandwidth() to the base interface. */
export interface D3BandScale extends D3Scale {
	bandwidth(): number;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** A column name (string) or inline Mosaic SQL expression node. */
export type FieldRef = string | ExprNode;

/**
 * What a mark channel accepts: a FieldRef, or a lazy node the mark lifecycle
 * resolves against the chart's state, such as bin() or a rolling average.
 */
export type ChannelRef = FieldRef | AutoBinNode | RollingAvgNode;

/** Color prop: CSS constant, column name, object wrapper {field, scheme?, type?}, SQL node, or null. */
export type ColorProp =
	| FieldRef
	| {
			field: string;
			scheme?: ColorScheme;
			type?: ColorScaleType;
			constant?: number;
			exponent?: number;
	  }
	| null;

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/**
 * A SQL transform modifies the Mosaic Query AST before execution.
 * Receives the same MarkConfig as JS transforms (mark type + resolved
 * channel aliases) so it can locate value/band columns in the select list.
 */
export interface SqlTransform {
	stage: 'sql';
	type: string;
	/** Spec-format representation for export. Set by factory functions. */
	spec?: Record<string, unknown>;
	apply(query: SelectQuery, config?: MarkConfig): SelectQuery;
	/** Channel aliases this transform adds to the result beyond the base select (e.g. stack's y0/y1). */
	channels?: string[];
	/**
	 * The row predicate this transform adds to the query, when that is all it does
	 * (`filter`). It applies to the source rows, before any grouping, so a query
	 * over a pre-aggregated table cannot apply it (the columns it names are gone):
	 * the table is built with it instead, and the read leaves it out.
	 */
	where?: unknown;
	/**
	 * The channels whose values identify each row, leading term first, when this
	 * transform guarantees exactly one row per combination of them — or null when
	 * it makes no such guarantee for a query with these aliases.
	 *
	 * The query assembler orders the OUTERMOST query by these, which is what
	 * makes row `i` the same category on every update; and the first is the
	 * band a mark may morph along.
	 */
	alignment?(aliases: string[], config?: MarkConfig): string[] | null;
	describe?(): string;
}

/** A JS transform processes client-side data after the query returns. */
export interface JsTransform {
	stage: 'js';
	type: string;
	/** Spec-format representation for export. Set by factory functions. */
	spec?: Record<string, unknown>;
	apply(data: DataAccessor, config: MarkConfig, scales?: ScaleMap): DataAccessor;
	channels?: string[];
	describe?(): string;
}

export type Transform = SqlTransform | JsTransform;

// ---------------------------------------------------------------------------
// Mark config (passed to JS transforms)
// ---------------------------------------------------------------------------

/**
 * A channel whose values are category ids, and what identifies them.
 *
 * One object per channel so the facts about a dim travel together: the name a
 * transform joins against, how many ids it holds, and the reserved Other id
 * bucketed into it. Kept apart, they were four maps keyed three different ways.
 */
export interface ChannelIdentity {
	/** The dim table the ids come from. Session-suffixed and engine-owned; never rebuilt from a field name. */
	dim: string;
	/** How many ids the dim held when identity was set up. */
	size: number;
	/** An x or y axis, as opposed to colour or facet. */
	positional: boolean;
	/** The reserved id past-the-cutoff rows are bucketed into, once reserved. */
	otherId?: number;
	/**
	 * The table of ids the mark's own table holds, which `dense()` pads from: the
	 * dim spans every table on the field, and a chart must not pad a slot for a
	 * category only another table has. Absent before that table has folded in,
	 * when dense() pads from the whole dim as it did before.
	 */
	present?: string;
	/**
	 * The NULL category's id, when the mark drops NULL (`nulls="drop"`): `dense()`
	 * pads no row for it, as its rows are filtered out.
	 */
	dropNullId?: number;
}

/**
 * One binned channel's bins, as `bin()` resolved them for a query: edge k is
 * `min + alpha * (k + offset)` for k in [0, count). A rect's upper edge is the
 * same bins with offset 1.
 */
export interface BinPadding {
	min: number;
	alpha: number;
	count: number;
	offset: number;
}

export interface MarkConfig {
	markType: string;
	table: string;
	x?: string;
	y?: string;
	color?: string;
	/** Every channel carrying category ids, keyed by channel. Absent until identity setup. */
	identity?: Record<string, ChannelIdentity>;
	/** The query's GROUP BY channels, or null when it does not aggregate. Per query. */
	groupKeys?: string[] | null;
	/** The numeric `bin()` channels and their bins, which `dense()` pads from. Per query. */
	bins?: Record<string, BinPadding> | null;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Scale map (passed to JS transforms)
// ---------------------------------------------------------------------------

export interface ScaleMap {
	x?: { bandwidth?(): number; domain?(): unknown[]; range?(): number[] };
	y?: { bandwidth?(): number; domain?(): unknown[]; range?(): number[] };
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Color schemes — must match the keys in src/lib/scales/color-utils.js
// ---------------------------------------------------------------------------

export type ColorSchemeCategory =
	| 'category10'
	| 'accent'
	| 'dark2'
	| 'paired'
	| 'pastel1'
	| 'pastel2'
	| 'set1'
	| 'set2'
	| 'set3'
	| 'tableau10';

export type ColorSchemeSequential =
	| 'blues'
	| 'greens'
	| 'greys'
	| 'oranges'
	| 'purples'
	| 'reds'
	| 'viridis'
	| 'inferno'
	| 'magma'
	| 'plasma'
	| 'cividis'
	| 'turbo'
	| 'warm'
	| 'cool'
	| 'cubehelixdefault'
	| 'bugn'
	| 'bupu'
	| 'gnbu'
	| 'orrd'
	| 'pubugn'
	| 'pubu'
	| 'purd'
	| 'rdpu'
	| 'ylgnbu'
	| 'ylgn'
	| 'ylorbr'
	| 'ylorrd';

export type ColorSchemeDiverging =
	| 'brbg'
	| 'prgn'
	| 'piyg'
	| 'puor'
	| 'rdbu'
	| 'rdgy'
	| 'rdylbu'
	| 'rdylgn'
	| 'spectral';

export type ColorSchemeCyclical = 'rainbow' | 'sinebow';

export type ColorScheme =
	| ColorSchemeCategory
	| ColorSchemeSequential
	| ColorSchemeDiverging
	| ColorSchemeCyclical;

export type ColorScaleType =
	| 'ordinal'
	| 'sequential'
	| 'diverging'
	| 'cyclical'
	| 'log'
	| 'symlog'
	| 'sqrt'
	| 'pow';

/**
 * The normalization transform applied to continuous color values before
 * mapping into the [0,1] ramp coordinate. 'linear' is the default for
 * ordinal/sequential/diverging/cyclical; the others correspond to
 * ColorScaleType values that imply a non-linear mapping.
 */
export type ColorTransformType = 'linear' | 'log' | 'symlog' | 'sqrt' | 'pow';

// ---------------------------------------------------------------------------
// Curve types — must match the keys in src/lib/gpu/CurveShaderLib.js
// ---------------------------------------------------------------------------

export type CurveType =
	| 'linear'
	| 'step'
	| 'step-before'
	| 'step-after'
	| 'catmull-rom'
	| 'monotone'
	| 'monotone-x'
	| 'monotone-y'
	| 'bump'
	| 'bump-x'
	| 'bump-y';

// ---------------------------------------------------------------------------
// Sort configuration for marks
// ---------------------------------------------------------------------------

export interface SortConfig {
	x?: string;
	y?: string;
	order?: 'asc' | 'desc';
}

/**
 * A `sort` prop, resolved: which band axis to order, by which channel, which
 * way. `axis` is the key the prop was given under (`sort={{ x: 'y' }}` orders
 * the x axis by y) and is what the rank transform ranks.
 */
export type NormalizedSortConfig = {
	axis: 'x' | 'y';
	channel: string;
	direction: 'asc' | 'desc';
} | null;

// ---------------------------------------------------------------------------
// Mark prop building blocks
// ---------------------------------------------------------------------------

/**
 * Explicit category domain for band/point scales.
 *
 * DimValue rather than string: a band axis over an INTEGER or BIGINT column has
 * a numeric domain, and the entries are looked up in a dim keyed by the source
 * type, so they must arrive uncoerced. See DimValue.
 */
export interface DomainConfig {
	x?: DimValue[];
	y?: DimValue[];
}

/** Props shared by every mark component. */
export interface BaseMarkProps {
	table: string;
	selection?: string;
	/**
	 * How this mark responds to selections in its filter group.
	 *
	 * - `'auto'` (the default): a categorical selection (a legend, a Toggle, a
	 *   band label) on a field this mark draws by, its band axis or its ordinal
	 *   colour, dims it: it keeps its data and the unselected categories fade.
	 *   Any other selection filters it.
	 * - `'filter'`: every selection filters it, even on a field it draws by, so
	 *   its aggregates are recomputed for the subset: top N within the selected
	 *   region, shares within the selected groups.
	 * - `'ignore'`: no selection filters or dims it, its own chart's controls
	 *   included, and a selection change never re-queries it. For context: the
	 *   whole drawn faintly behind a filtered part, on the same scales, whose
	 *   extent then keeps the axis still while the part changes. A click on its
	 *   Other bar toggles, as under `'auto'`.
	 *
	 * Background totals are two layers of the same mark: an `'ignore'` one
	 * drawn faintly behind, the whole, and an `'auto'` one in front, the part a
	 * brush or click elsewhere leaves. Each bar shrinks over its total instead
	 * of losing it, and the y axis keeps the total's extent:
	 *
	 * ```svelte
	 * <BarMarkY table="flights" x="carrier" y={count()} selectionResponse="ignore" fillOpacity={0.2} />
	 * <BarMarkY table="flights" x="carrier" y={count()} />
	 * ```
	 *
	 * With a top N, choose which layer ranks; the other gets
	 * `contributeDomain={false}` and follows the axis:
	 *
	 * - the back layer, to rank once over the whole: the same N categories
	 *   stay while the front bars shrink;
	 * - the front layer, to re-rank within the selection: the N categories
	 *   change with it, and the whole is drawn for whichever are shown.
	 *
	 * Not with `includeOthers`: the follower has no Other row (see
	 * `contributeDomain`).
	 *
	 * A `'filter'` mark never dims. A legend, Toggle or band label filters it
	 * in its own chart too: every such control on the same fields shares one
	 * selection, so any chart with one would otherwise ignore it, and this
	 * chart's legend re-ranks its own top N. A Toggle on its own bars therefore
	 * filters them: the unselected bars leave the chart. Known limit: on a band
	 * axis drawn from the data (a sorted mark), clicking a label filters the
	 * other categories out, their labels go with them, and a second category
	 * cannot be added from this chart; clicking the label again clears it. A brush still skips its
	 * own chart, so the marks under it do not move while it is dragged.
	 */
	selectionResponse?: SelectionResponse;
	/**
	 * Whether this mark adds its categories to a band axis's domain (default
	 * `true`). `false`: the mark follows the axis the other marks on it decide
	 * (their categories, their order); rows of categories the axis does not show
	 * are not drawn. For a layer that gives context to another, such as the whole
	 * behind a part. It cannot rank or reduce its own categories, so `topN`, `sort`
	 * and an explicit `domain` are refused with it (an error is logged and the
	 * mark contributes).
	 *
	 * Known limit: when the axis shows an Other bucket (another mark's topN with
	 * `includeOthers`), a follower has no Other row of its own. Its bars of
	 * categories that leave the axis walk to Other's slot and are gone when the
	 * transition ends, and nothing draws the whole behind Other. Folding such
	 * categories into an Other row would need the follower's query to depend on
	 * the axis's current categories.
	 */
	contributeDomain?: boolean;
	/**
	 * What this mark does with NULL in its categorical channels: its band axis,
	 * ordinal colour, series and facet.
	 *
	 * - `'keep'` (the default): NULL is a category like any other. It is ranked
	 *   by its measure, drawn, and labelled "(null)", in the null colour.
	 * - `'drop'`: rows whose value in any of those channels is NULL are left out
	 *   before any transform, so a top N ranks, and Other sums, without them.
	 */
	nulls?: NullsResponse;
	scheme?: ColorScheme;
	limit?: number;
	transforms?: Transform[];
	sort?: SortConfig | null;
	domain?: DomainConfig | null;
	tooltip?: boolean;
	tooltipProximity?: 'x' | 'y' | 'xy';
	tip?: (FieldRef | '*')[] | false;
	fitDomain?: 'x' | 'y' | boolean;
}

/**
 * Props for marks that support band scale padding (Bar, Rect).
 *
 * No `align`: the GPU band layout places a category at the centre of its slot
 * and has no parameter for anything else, so the only alignment this library
 * can honour is d3's default. It was a prop for a while, reached d3 alone, and
 * silently moved SVG consumers off the bars.
 */
export interface BandScaleProps {
	padding?: number;
	paddingInner?: number;
	paddingOuter?: number;
}

/** Props for marks that support continuous scale type preference. */
export interface ContinuousScaleTypeProps {
	preferredXScaleType?: ScaleType | null;
	preferredYScaleType?: ScaleType | null;
}

/** Props for marks that render rectangles with spatial offsets (Bar, Rect). */
export interface RectOffsetProps {
	inset?: number;
	dx?: number;
	dy?: number;
}

/** Props for connected topology marks (Line, Area). */
export interface ConnectedTopologyProps {
	z?: FieldRef | null;
	curve?: CurveType;
	/** Field to control vertex connection order. Defaults to the dimension channel (x for lines/areaY, y for areaX). */
	order?: FieldRef;
}

// ---------------------------------------------------------------------------
// LOD (Level of Detail) configuration
// ---------------------------------------------------------------------------

/** Configuration for auto-dots behavior on line/area marks. */
export interface LODDotsConfig {
	/** Base dot radius in pixels. Default: dotRadius prop or 2.5. */
	r?: number;
	/** Avg pixel spacing at which dots reach full size (smoothstep upper edge). Default: 18. */
	threshold?: number;
}

/** LOD state snapshot, passed to onLODChange callback. */
export interface LODChangeState {
	decimating: boolean;
	dotRadius: number;
	visibleCount: number;
	density: number;
	smoothingWindow: number;
}

/** Configuration for rolling average smoothing overlay on line marks. */
export interface LODSmoothConfig {
	/** Rolling avg window size (rows in each direction for centered, total for trailing). 0 = off. */
	window?: number;
	/** Window mode: 'centered' (±N, no lag) or 'trailing' (←N, backward-only). Default: 'centered'. */
	mode?: 'centered' | 'trailing' | 'leading';
}

/** Object-form LOD configuration. */
export interface LODConfig {
	/** Auto-dots config, or false to disable dots while keeping decimation. */
	dots?: LODDotsConfig | false;
	/** Rolling average smoothing overlay config, or false to disable. */
	smooth?: LODSmoothConfig | false;
	/** Decimation behavior: 'auto' (density-based), true (always), false (never). Default: 'auto'. */
	decimate?: boolean | 'auto';
	/** Bin step multiplier (binned mode). Default: 1.0. */
	multiplier?: number;
	/** Callback fired on LOD state transitions (decimation toggle, dots appear/disappear). */
	onLODChange?: (state: LODChangeState) => void;
}

// ---------------------------------------------------------------------------
// Chart context — the object set via setContext('chart', ...)
// ---------------------------------------------------------------------------

import type { Margin, Point, AxesResult } from '$lib/layout/ChartLayout.svelte';
import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import type { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
import type { LogScaleState } from '$lib/scales/LogScaleState.svelte';
import type { SymlogScaleState } from '$lib/scales/SymlogScaleState.svelte';
import type { TooltipManager } from '$lib/interactors/TooltipManager.svelte';

/** Continuous axis scales (support zoom, pan, animated domain). */
export type ContinuousScaleState =
	| LinearScaleState
	| TimeScaleState
	| LogScaleState
	| SymlogScaleState;

/** Union of all scale state types that can appear on x/y axes. */
export type ScaleStateInstance = ContinuousScaleState | BandScaleState;

/**
 * The chart context object created by ChartCell/ChartContainer and
 * consumed by marks, renderers, interactors, axes, and guides via
 * `getContext<ChartContext>('chart')`.
 *
 * D3 scale properties are typed as `any` because D3 scales are mutated
 * in place and have complex generic signatures that don't add value here.
 */
export interface ChartContext {
	// Layout
	readonly width: number | null;
	readonly height: number;
	readonly innerWidth: number;
	readonly innerHeight: number;
	readonly margin: Margin;
	readonly chartId: string;
	readonly clipPathId: string;
	readonly clipPathUrl: string;
	readonly isReady: boolean;
	readonly innerTransform: string;
	readonly dimensions: {
		width: number | null;
		height: number;
		innerWidth: number;
		innerHeight: number;
		margin: Margin;
	};

	updateWidth: (w: number) => void;
	updateHeight: (h: number) => void;
	updateMargin: (m: Partial<Margin>) => void;
	toInnerCoordinates: (p: Point) => Point;
	toScreenCoordinates: (p: Point) => Point;
	isWithinInnerBounds: (p: Point) => boolean;
	getActiveAxes: (p: Point) => AxesResult;
	reset: () => void;
	getDebugInfo: () => Record<string, unknown>;

	// D3 scales (cell-local, mutated in place)
	readonly xScale: D3Scale | null;
	readonly yScale: D3Scale | null;
	readonly xTargetScale: D3Scale | null;
	readonly yTargetScale: D3Scale | null;

	readonly xLabel: string | null | undefined;
	readonly yLabel: string | null | undefined;
	readonly xColumnName: string | null;
	readonly yColumnName: string | null;

	// Data points
	readonly currentXDataPoint: number | null | undefined;
	readonly currentYDataPoint: number | null | undefined;
	readonly currentXScreenPoint: number | null | undefined;
	readonly currentYScreenPoint: number | null | undefined;

	// Scale states
	readonly xScaleState: ScaleStateInstance | null | undefined;
	readonly yScaleState: ScaleStateInstance | null | undefined;
	readonly scaleTypes: { x: string; y: string } | null | undefined;
	readonly scalesReady: boolean | undefined;
	readonly active: boolean | undefined;

	// Band support
	readonly xBandwidth: number | undefined;
	readonly yBandwidth: number | undefined;

	// Scale registration
	registerScaleType: (
		dimension: 'x' | 'y',
		type: string,
		priority: number,
		markId: string,
		config: Record<string, unknown>,
		columnName: FieldRef | null
	) => void;
	unregisterScaleType: (dimension: 'x' | 'y', markId: string) => void;

	readonly binStepMultiplier: number | undefined;
	adjustBinMultiplier?: (delta: number) => void;
	setBinStepMultiplier?: (value: number) => void;

	// Tooltip
	readonly tooltipManager: TooltipManager | null;

	// Parallel coordinates
	readonly parallelScales?: {
		scaleStates: ScaleStateInstance[];
		columns: string[];
		axisOrder: number[];
	} | null;
	/** A parallel mark's columns, its whole list in its order; empty when it goes. */
	setParallelColumns: (markId: string, columns: string[]) => void;
	reorderParallelAxis: (from: number, to: number) => void;
	readonly parallelReorderState?: { dataIdx: number | null; currentX: number | null };
	readonly animatedAxisXPositions?: number[];

	// Faceting
	/** A column name or a fixed SQL expression. See ChartContainer's fx prop. */
	fx: FieldRef | null;
	readonly isFaceted: boolean;
	readonly facetChartIds: string[];
	readonly facetBandScale: BandScaleState | null;
	/** Explicit facet cell order, in source values. See ChartContainer's fxDomain. */
	readonly fxDomain?: DimValue[] | null;

	// Configuration store
	readonly config: ChartConfig;

	// Pointer hooks (mutable slots set by interactors)
	onChartClick: ((event: PointerEvent) => void) | null;
	/**
	 * A press, offered to the interactor before the chart pans. `target` is the
	 * element under the pointer, which a brush reads for the handle it is on
	 * (brushHandleAt); `innerPoint` is in plot-area coordinates. Returns true when
	 * the interactor takes the press. Called again when the chart re-routes a
	 * press under way (reroutePress).
	 */
	onInteractorPointerDown:
		| ((target: Element, pointerId: number, innerPoint: Point) => boolean)
		| null;
	/** Every pointer move but a pan; `innerPoint` is the pointer in plot-area coordinates (a
	 *  shared buffer: read it before calling back into the layout). Returns true when the
	 *  interactor handled the move (a drag it captured). */
	onInteractorPointerMove: ((event: PointerEvent, innerPoint: Point) => boolean) | null;
	onInteractorPointerUp: ((event: PointerEvent) => boolean) | null;
	/**
	 * End the interactor's drag where it is, as a pointer up would but without
	 * treating a drag that never moved as a click (which clears a brush). The
	 * chart calls it when it re-routes the press.
	 */
	onInteractorDragEnd: (() => void) | null;
	/**
	 * Route the press under way again, as if it began now where the pointer is:
	 * end what it is doing (a pan, or the interactor's drag), then offer it to
	 * the interactor and pan if declined, as a new press would be. Brushes call
	 * it when Space changes, since one press can outlast that: with three-finger
	 * drag on a trackpad it goes on for seconds after the fingers lift. Without a
	 * press under way it does nothing.
	 */
	reroutePress: () => void;
	/**
	 * Selection sources to activate when the pointer enters the chart, so their
	 * preagg tables exist before the first gesture. Interactors add their
	 * handle's `activate` on mount and delete it on destroy.
	 */
	readonly activators: Set<() => void>;
}

export type { Margin, Point, AxesResult };

// ---------------------------------------------------------------------------
// WebGPU canvas context — the object set via setContext('webgpu-canvas', ...)
// ---------------------------------------------------------------------------

export interface WebGPUCanvasContext {
	getCanvasDimensions(): {
		width: number;
		height: number;
		cssWidth: number;
		cssHeight: number;
		currentDPR: number;
	};
	getMsaaSampleCount(): number;
	getDevice(): GPUDevice | undefined;
	getPresentationFormat(): GPUTextureFormat | undefined;
	isInitialized(): boolean;
	invalidate(): void;
	getDebugInfo(): Record<string, unknown>;
}
