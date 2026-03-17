/**
 * DivePlot Spec Schema — TypeScript interfaces defining the JSON contract
 * between spec producers (Python wrapper, JS API) and the spec renderer.
 */

import type { ColorScheme, CurveType, ScaleType, SortConfig } from '$lib/types';
import type { Coordinator } from '@uwdata/mosaic-core';

// =============================================================================
// Top-level spec
// =============================================================================

/** A layout item: either a single plot or a nested layout. */
export type LayoutItem = PlotSpec | { hconcat: LayoutItem[] } | { vconcat: LayoutItem[] };

export interface DivePlotSpec {
	data?: Record<string, DataSpec>;
	plot?: PlotSpec;
	hconcat?: LayoutItem[];
	vconcat?: LayoutItem[];
}

// =============================================================================
// Data definitions
// =============================================================================

export type DataSpec = FileDataSpec | SqlDataSpec | InlineDataSpec;

export interface FileDataSpec {
	url: string;
	type: 'parquet' | 'csv' | 'json';
}

export interface SqlDataSpec {
	sql: string;
	type: 'sql';
}

export interface InlineDataSpec {
	values: Record<string, unknown>[];
	type: 'inline';
}

// =============================================================================
// Plot
// =============================================================================

export interface LegendSpec {
	color: string;
	title?: string | null;
	columns?: number | null;
	swatchSize?: number;
	swatchRadius?: number;
	position?: 'top' | 'right';
	orientation?: 'horizontal' | 'vertical' | null;
	/** Explicit selection name for legend toggle filtering. Auto-derived from first mark if omitted. */
	selection?: string;
}

export interface PlotSpec {
	width?: number;
	height?: number;
	margin?: { top?: number; right?: number; bottom?: number; left?: number };
	xLabel?: string;
	yLabel?: string;
	fx?: string;
	columns?: number;
	marks: MarkSpec[];
	interactors?: InteractorSpec[];
	useXSelection?: boolean;
	useYSelection?: boolean;
	xZoomLimit?: number;
	yZoomLimit?: number;
	xPanLimit?: number;
	yPanLimit?: number;
	xDisableZoom?: boolean;
	yDisableZoom?: boolean;
	legend?: LegendSpec | boolean;
}

// =============================================================================
// Interactor specs — discriminated union on `interactor`
// =============================================================================

export type InteractorSpec =
	| IntervalXSpec
	| IntervalYSpec
	| Interval2DSpec
	| ToggleSpec
	| DerivedIntervalSpec;

export interface IntervalXSpec {
	interactor: 'intervalX';
	selection?: string;
	field?: string;
}

export interface IntervalYSpec {
	interactor: 'intervalY';
	selection?: string;
	field?: string;
}

export interface Interval2DSpec {
	interactor: 'interval2D';
	selection?: string;
	xField?: string;
	yField?: string;
}

export interface ToggleSpec {
	interactor: 'toggle';
	selection?: string;
	field: string;
}

export interface DerivedIntervalSpec {
	interactor: 'derivedInterval';
	source: string;
	selection?: string;
	offset: string;
	axis?: 'x' | 'y';
}

// =============================================================================
// Field specs — column names, aggregates, or bin expressions
// =============================================================================

/** A column name, aggregate shorthand ("count()"), or structured object. */
export type FieldSpec = string | AggregateFieldSpec | BinFieldSpec | WindowFieldSpec | RawSqlFieldSpec;

export interface AggregateFieldSpec {
	aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median';
	field?: string;
}

export interface BinFieldSpec {
	bin: string;
	steps?: number;
}

export interface RawSqlFieldSpec {
	/** Raw SQL expression, e.g. 'EXTRACT(HOUR FROM "ts")'. */
	sql: string;
}

export interface WindowFieldSpec {
	/** Aggregate function to apply over the window. */
	window: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median';
	/** Column to aggregate (omit for 'count'). */
	field?: string;
	/** Column to order rows by within the window. */
	orderBy?: string;
	/** Column to partition (group) the window by. */
	partitionBy?: string;
	/**
	 * Row frame as [start, end]. Negative = preceding, 0 = current row, positive = following.
	 * E.g. [-10, 0] = trailing 10 rows, [-5, 5] = centered ±5.
	 */
	frame?: [number, number];
}

// =============================================================================
// Mark specs — discriminated union on `mark`
// =============================================================================

export type MarkSpec =
	| DotMarkSpec
	| BarXMarkSpec
	| BarYMarkSpec
	| LineMarkSpec
	| AreaYMarkSpec
	| AreaXMarkSpec
	| RectMarkSpec
	| RectXMarkSpec
	| RectYMarkSpec
	| TextMarkSpec;

interface BaseMarkSpec {
	table: string;
	selection?: string; // selection group name (auto-created in SelectionRegistry)
	scheme?: ColorScheme;
	limit?: number;
	filterNulls?: boolean;
	transforms?: TransformSpec[];
	sort?: SortConfig | null;
	domain?: { x?: string[]; y?: string[] } | null;
	tooltip?: boolean;
	tooltipProximity?: 'x' | 'y' | 'xy';
	tip?: (string | '*')[] | false;
	fitDomain?: 'x' | 'y' | boolean;
}

interface ContinuousScaleTypeSpec {
	preferredXScaleType?: ScaleType | null;
	preferredYScaleType?: ScaleType | null;
}

export interface DotMarkSpec extends BaseMarkSpec, ContinuousScaleTypeSpec {
	mark: 'dot';
	x: FieldSpec;
	y: FieldSpec;
	fill?: FieldSpec | null;
	opacity?: number;
	r?: number | FieldSpec;
	radiusRange?: [number, number];
}

export interface BarXMarkSpec extends BaseMarkSpec {
	mark: 'barX';
	x: FieldSpec;
	x1?: FieldSpec;
	x2?: FieldSpec;
	y: FieldSpec;
	fill?: FieldSpec | null;
	opacity?: number;
	padding?: number;
	paddingInner?: number;
	paddingOuter?: number;
	align?: number;
	inset?: number;
	dx?: number;
	dy?: number;
}

export interface BarYMarkSpec extends BaseMarkSpec {
	mark: 'barY';
	x: FieldSpec;
	y: FieldSpec;
	y1?: FieldSpec;
	y2?: FieldSpec;
	fill?: FieldSpec | null;
	opacity?: number;
	padding?: number;
	paddingInner?: number;
	paddingOuter?: number;
	align?: number;
	inset?: number;
	dx?: number;
	dy?: number;
}

export interface LineMarkSpec extends BaseMarkSpec, ContinuousScaleTypeSpec {
	mark: 'line';
	x: FieldSpec;
	y: FieldSpec;
	stroke?: FieldSpec | null;
	z?: FieldSpec | null;
	strokeWidth?: number;
	dotRadius?: number;
	opacity?: number;
	curve?: CurveType;
	lod?:
		| boolean
		| {
				dots?: { r?: number; threshold?: number } | false;
				smooth?: { window?: number; mode?: 'centered' | 'trailing' | 'leading' } | false;
				decimate?: boolean | 'auto';
				multiplier?: number;
		  };
}

export interface AreaYMarkSpec extends BaseMarkSpec, ContinuousScaleTypeSpec {
	mark: 'areaY';
	x: FieldSpec;
	y: FieldSpec;
	y1?: FieldSpec;
	y2?: FieldSpec;
	fill?: FieldSpec | null;
	z?: FieldSpec | null;
	fillOpacity?: number;
	stroke?: string | null; // CSS constant
	strokeWidth?: number;
	dotRadius?: number;
	autoDots?: boolean;
	curve?: CurveType;
}

export interface AreaXMarkSpec extends BaseMarkSpec, ContinuousScaleTypeSpec {
	mark: 'areaX';
	y: FieldSpec;
	x: FieldSpec;
	x1?: FieldSpec;
	x2?: FieldSpec;
	fill?: FieldSpec | null;
	z?: FieldSpec | null;
	fillOpacity?: number;
	stroke?: string | null; // CSS constant
	strokeWidth?: number;
	dotRadius?: number;
	autoDots?: boolean;
	curve?: CurveType;
}

export interface RectMarkSpec extends BaseMarkSpec, ContinuousScaleTypeSpec {
	mark: 'rect';
	x?: FieldSpec | null;
	x1?: FieldSpec | null;
	x2?: FieldSpec | null;
	y?: FieldSpec | null;
	y1?: FieldSpec | null;
	y2?: FieldSpec | null;
	fill?: FieldSpec | null;
	opacity?: number;
	padding?: number;
	paddingInner?: number;
	paddingOuter?: number;
	align?: number;
	inset?: number;
	dx?: number;
	dy?: number;
}

export interface RectXMarkSpec extends BaseMarkSpec {
	mark: 'rectX';
	x: FieldSpec;
	x1?: FieldSpec;
	x2?: FieldSpec;
	y?: FieldSpec | null;
	y1?: FieldSpec | null;
	y2?: FieldSpec | null;
	fill?: FieldSpec | null;
	opacity?: number;
	inset?: number;
	dx?: number;
	dy?: number;
	preferredYScaleType?: ScaleType | null;
	fitDomain?: 'x' | 'y' | boolean;
}

export interface RectYMarkSpec extends BaseMarkSpec {
	mark: 'rectY';
	x?: FieldSpec | null;
	x1?: FieldSpec | null;
	x2?: FieldSpec | null;
	y: FieldSpec;
	y1?: FieldSpec;
	y2?: FieldSpec;
	fill?: FieldSpec | null;
	opacity?: number;
	inset?: number;
	dx?: number;
	dy?: number;
	preferredXScaleType?: ScaleType | null;
	fitDomain?: 'x' | 'y' | boolean;
}

export interface TextMarkSpec extends BaseMarkSpec, ContinuousScaleTypeSpec {
	mark: 'text';
	x: FieldSpec;
	y: FieldSpec;
	text: FieldSpec;
	fill?: FieldSpec | null;
	fontSize?: number;
	fontWeight?: string;
	fontFamily?: string | null;
	dx?: number;
	dy?: number;
	textAnchor?: 'start' | 'middle' | 'end';
	lineAnchor?: 'top' | 'middle' | 'bottom';
	rotate?: number;
}

// =============================================================================
// Transform specs
// =============================================================================

export type TransformSpec =
	| FilterTransformSpec
	| HavingTransformSpec
	| LimitTransformSpec
	| OrderByTransformSpec
	| TopNTransformSpec
	| StackYTransformSpec
	| StackXTransformSpec
	| NormalizeTransformSpec
	| DodgeTransformSpec;

export interface FilterTransformSpec {
	transform: 'filter';
	condition: string;
}

export interface HavingTransformSpec {
	transform: 'having';
	condition: string;
}

export interface LimitTransformSpec {
	transform: 'limit';
	value: number;
}

export interface OrderByTransformSpec {
	transform: 'orderby';
	fields: string[];
}

export interface TopNTransformSpec {
	transform: 'topN';
	n: number;
	by?: string;
	includeOthers?: boolean;
}

export interface StackYTransformSpec {
	transform: 'stackY';
	offset?: null | 'expand' | 'center';
}

export interface StackXTransformSpec {
	transform: 'stackX';
	offset?: null | 'expand' | 'center';
}

export interface NormalizeTransformSpec {
	transform: 'normalize';
}

export interface DodgeTransformSpec {
	transform: 'dodge';
	bandwidth?: number;
}

// =============================================================================
// Render options and handle
// =============================================================================

export interface RenderOptions {
	/** Base URL for resolving relative data URLs */
	baseUrl?: string;
	/** Provide an existing Mosaic Coordinator instead of creating one */
	coordinator?: Coordinator;
}

export interface DivePlotHandle {
	/** Destroy the rendered chart and clean up resources */
	destroy(): void;
}
