// src/lib/types.ts
//
// Shared type definitions for Fjader.
// This file is the single source of truth for types that cross module boundaries.

import type { ExprNode, SelectQuery } from '@uwdata/mosaic-sql';
import type { DataAccessor } from '$lib/data/DataAccessor';
import type { ChartConfig } from '$lib/config/ChartConfig.svelte';
import type { DimValue } from '$lib/query-engine/categorical-identity';
import type { AutoBinNode } from '$lib/sql/bin';
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
	scheme?: ColorScheme;
	limit?: number;
	filterNulls?: boolean;
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
	onInteractorPointerDown: ((event: PointerEvent, innerPoint: Point) => boolean) | null;
	/** Every pointer move but a pan; `innerPoint` is the pointer in plot-area coordinates (a
	 *  shared buffer: read it before calling back into the layout). Returns true when the
	 *  interactor handled the move (a drag it captured). */
	onInteractorPointerMove: ((event: PointerEvent, innerPoint: Point) => boolean) | null;
	onInteractorPointerUp: ((event: PointerEvent) => boolean) | null;
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
