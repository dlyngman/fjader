// src/lib/types.ts
//
// Shared type definitions for DivePlot.
// This file is the single source of truth for types that cross module boundaries.

import type { ExprNode, SelectQuery } from '@uwdata/mosaic-sql';
import type { Selection } from '@uwdata/mosaic-core';
import type { Coordinator } from '@uwdata/mosaic-core';

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export type ContinuousScaleType = 'linear' | 'log' | 'pow' | 'identity';
export type DiscreteScaleType = 'band' | 'point';
export type TemporalScaleType = 'time';
export type ScaleType = ContinuousScaleType | DiscreteScaleType | TemporalScaleType;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** A column name (string) or inline Mosaic SQL expression node. */
export type FieldRef = string | ExprNode;

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/** A SQL transform modifies the Mosaic Query AST before execution. */
export interface SqlTransform {
	stage: 'sql';
	type: string;
	apply(query: SelectQuery): SelectQuery;
	describe?(): string;
}

/** A JS transform processes client-side data after the query returns. */
export interface JsTransform {
	stage: 'js';
	type: string;
	apply(
		data: Record<string, unknown>[],
		config: MarkConfig,
		scales?: ScaleMap
	): Record<string, unknown>[];
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

export type ColorScaleType = 'ordinal' | 'sequential' | 'diverging' | 'cyclical';

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

export type { Selection, Coordinator };

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

/** Props shared by every mark component. */
export interface BaseMarkProps {
	table: string;
	selection?: Selection;
	color?: FieldRef | null;
	scheme?: ColorScheme;
	limit?: number;
	filterNulls?: boolean;
	transforms?: Transform[];
	sort?: SortConfig | null;
	tooltip?: boolean;
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
	stroke?: FieldRef | null;
	curve?: CurveType;
}

// ---------------------------------------------------------------------------
// Chart context — the object set via setContext('chart', ...)
// ---------------------------------------------------------------------------

import type { Margin, Point, AxesResult } from '$lib/layout/ChartLayout.svelte';
import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import type { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
import type { TooltipManager } from '$lib/interactors/TooltipManager.svelte';

/** Union of all scale state types that can appear on x/y axes. */
export type ScaleStateInstance = LinearScaleState | BandScaleState | TimeScaleState;

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

	// D3 scales (cell-local, mutated in place — typed as any)
	readonly xScale: any;
	readonly yScale: any;
	readonly xTargetScale: any;
	readonly yTargetScale: any;

	readonly xLabel: string | null | undefined;
	readonly yLabel: string | null | undefined;

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
		dimension: string,
		type: string,
		priority: number,
		markId: string,
		config: Record<string, unknown>,
		columnName: unknown
	) => void;
	unregisterScaleType: (dimension: string, markId: string) => void;
	getScaleRequirementsSummary: () => unknown;

	readonly binStepMultiplier: number | undefined;

	// Client registration
	registerClient: (client: unknown) => () => void;
	readonly markClients: Set<unknown> | undefined;

	// Tooltip
	readonly tooltipManager: TooltipManager | null;

	// Faceting
	fx: string | null;
	readonly isFaceted: boolean;
	readonly facetChartIds: string[];
	readonly facetBandScale: BandScaleState | null;

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
