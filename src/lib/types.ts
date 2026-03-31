// src/lib/types.ts
//
// Shared type definitions for DivePlot.
// This file is the single source of truth for types that cross module boundaries.

import type { ExprNode, SelectQuery } from '@uwdata/mosaic-sql';
import type { Selection, Coordinator, MosaicClient } from '@uwdata/mosaic-core';
import type { DataAccessor } from '$lib/data/DataAccessor';
import type { ChartConfig } from '$lib/config/ChartConfig.svelte';

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

/** Color prop: CSS constant, column name, object wrapper {field, scheme?, type?}, SQL node, or null. */
export type ColorProp =
	| FieldRef
	| { field: string; scheme?: ColorScheme; type?: ColorScaleType; constant?: number; exponent?: number }
	| null;

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/** A SQL transform modifies the Mosaic Query AST before execution. */
export interface SqlTransform {
	stage: 'sql';
	type: string;
	/** Spec-format representation for export. Set by factory functions. */
	spec?: Record<string, unknown>;
	apply(query: SelectQuery): SelectQuery;
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

export interface MarkConfig {
	markType: string;
	table: string;
	x?: string;
	y?: string;
	color?: string;
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
// Re-export Mosaic types for convenience
// ---------------------------------------------------------------------------

export type { Selection, Coordinator, MosaicClient };

// ---------------------------------------------------------------------------
// Sort configuration for marks
// ---------------------------------------------------------------------------

export interface SortConfig {
	x?: string;
	y?: string;
	order?: 'asc' | 'desc';
}

export type NormalizedSortConfig = { channel: string; direction: 'asc' | 'desc' } | null;

// ---------------------------------------------------------------------------
// Mark prop building blocks
// ---------------------------------------------------------------------------

/** Explicit category domain for band/point scales. */
export interface DomainConfig {
	x?: string[];
	y?: string[];
}

/** Props shared by every mark component. */
export interface BaseMarkProps {
	table: string;
	selection?: string | Selection;
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

/** Props for marks that support band scale padding/alignment (Bar, Rect). */
export interface BandScaleProps {
	padding?: number;
	paddingInner?: number;
	paddingOuter?: number;
	align?: number;
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
	readonly xCategoryPositions: Float32Array | null | undefined;
	readonly yCategoryPositions: Float32Array | null | undefined;
	readonly categoryPositionsReady: boolean | undefined;
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

	// Client registration
	registerClient: (client: MosaicClient) => () => void;
	readonly markClients: Set<MosaicClient> | undefined;

	// Tooltip
	readonly tooltipManager: TooltipManager | null;

	// Parallel coordinates
	readonly parallelScales?: {
		scaleStates: ScaleStateInstance[];
		columns: string[];
		axisOrder: number[];
	} | null;
	registerParallelColumn: (column: string, markId: string) => void;
	unregisterParallelColumn: (column: string, markId: string) => void;
	reorderParallelAxis: (from: number, to: number) => void;
	readonly parallelReorderState?: { dataIdx: number | null; currentX: number | null };
	readonly animatedAxisXPositions?: number[];

	// Faceting
	fx: string | null;
	readonly isFaceted: boolean;
	readonly facetChartIds: string[];
	readonly facetBandScale: BandScaleState | null;

	// Configuration store
	readonly config: ChartConfig;

	// Pointer hooks (mutable slots set by interactors)
	onChartClick: ((event: PointerEvent) => void) | null;
	onInteractorPointerDown: ((event: PointerEvent, innerPoint: Point) => boolean) | null;
	onInteractorPointerMove: ((event: PointerEvent) => boolean) | null;
	onInteractorPointerUp: ((event: PointerEvent) => boolean) | null;
	onInteractorPointerEnter: (() => void) | null;
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
