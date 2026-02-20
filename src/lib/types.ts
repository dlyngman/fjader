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
