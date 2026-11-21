/**
 * What a chart draws because a component declared it, rather than rendered it
 * where it was placed: axes, parallel axes, the plot border, and SVG overlays.
 *
 * A declaration component registers its settings here. Where it is placed it
 * reads no CELL context (a cell's size, hover point, place in the grid: in a
 * facet grid a declaration sits in the hidden pass-through, in no cell), only
 * the chart's (`DeclarationChart`: its config and shared scales); what it
 * needs per cell runs in what each cell draws it with.
 *
 * GPU declarations (`AxisLeft`, `AxisBottom`, `ParallelAxes`, `Frame`)
 * register getters over their props, drawn in the cell's `WebGPUCanvas`
 * (`GpuAxis`, `GpuParallelAxes`, `PlotBorderRenderer`). Overlays
 * (`Crosshair`, `MarginLabel`, `AxisCenter`, `SvgLayer`, the brushes, `Toggle`)
 * register a snippet the cell renders in its foreground SVG (`declareOverlay`).
 *
 * One registry per chart (`ChartContainer`). A declaration is for every cell
 * of the chart, or for one: `ChartCell` renders its per-cell snippets
 * (`background`, `foreground`, `interactors`, `overlay`) inside a
 * `DeclarationScope` naming the cell, so a facet grid whose snippets render
 * once per cell gets one declaration per cell, each drawn in its own cell.
 */
import { getContext, onDestroy, type Snippet } from 'svelte';
import type { AxisSpec, ParallelAxesSpec } from '../axes/axis-spec';
import type { ChartContext, ScaleStateInstance } from '$lib/types';
import type { ChartConfig } from '$lib/config';

/** A plot border around the inner plot area (`<Frame/>`). */
export interface FrameSpec {
	readonly id: string;
}

/**
 * Where in a cell's foreground SVG an overlay draws: `clipped`, inside the plot
 * clip, under the hover dot and the hit target (Crosshair, AxisCenter,
 * SvgLayer); `interactors`, inside the clip, above the hit target, so a brush's
 * handles take pointer events (the brushes, Toggle); `margins`, unclipped, over
 * the plot and its margins, taking no pointer events (MarginLabel, SvgLayer
 * clip={false}).
 */
export type OverlaySlot = 'clipped' | 'interactors' | 'margins';

/**
 * An SVG overlay (`declareOverlay`): a snippet each cell renders in its
 * foreground SVG, with the cell's chart context. Defined where the overlay is
 * declared, so it reads that component's props reactively; rendered in the
 * cell, so a component inside it reads the cell's context (its hover point,
 * scales, size).
 */
export interface OverlaySpec {
	readonly snippet: Snippet<[ChartContext]>;
	readonly slot: OverlaySlot;
	/** Draw order within the slot, lower first. Registration order breaks ties only. */
	readonly zIndex: number;
}

/** Where a chart places a legend: above the plot, or to its right. */
export type LegendPosition = 'top' | 'right';

/**
 * A legend (`declareLegend`): HTML the chart renders once, outside its plot,
 * at `position`, with the chart's context. Several at one position render in
 * registration order.
 */
export interface LegendDeclaration {
	readonly snippet: Snippet;
	readonly position: LegendPosition;
}

interface Specs {
	axis: AxisSpec;
	parallel: ParallelAxesSpec;
	frame: FrameSpec;
	overlay: OverlaySpec;
	legend: LegendDeclaration;
}

export type DeclarationKind = keyof Specs;

export type ChartDeclaration = {
	[K in DeclarationKind]: {
		readonly kind: K;
		readonly spec: Specs[K];
		/** The one cell it is for, or null: every cell of the chart. */
		readonly cellId: string | null;
	};
}[DeclarationKind];

export const DECLARATION_REGISTRY = 'declaration-registry';
/** Set by `DeclarationScope`: the cell a declaration placed inside is for. */
export const DECLARATION_SCOPE = 'declaration-scope';
/**
 * Set by `ChartContainer`: what a declaration may read of its chart
 * (`DeclarationChart`). Not the 'chart' context, which is a cell's or the facet
 * pass-through's depending on where the declaration is placed, and so holds
 * cell fields (innerWidth, the hover point) that would be wrong in a grid.
 */
export const DECLARATION_CHART = 'declaration-chart';

/** A chart as a declaration sees it: what every cell shares, nothing of one cell. */
export interface DeclarationChart {
	readonly chartId: string;
	/** The chart's config: what a selection's own-chart rule (`chart:`) names. */
	readonly config: ChartConfig;
	readonly xScaleState: ScaleStateInstance | null | undefined;
	readonly yScaleState: ScaleStateInstance | null | undefined;
	/** The column the x scale reads, when one does (shared scales: the same in every cell). */
	readonly xColumnName: string | null;
	readonly yColumnName: string | null;
	readonly xLabel: string | null | undefined;
	readonly yLabel: string | null | undefined;
	/** A parallel coordinates chart's axes (shared scales), or null. */
	readonly parallelScales: ChartContext['parallelScales'];
}

/** The chart this declaration is placed in. Call during component initialisation. */
export function getDeclarationChart(component: string): DeclarationChart {
	const chart = getContext<DeclarationChart | undefined>(DECLARATION_CHART);
	if (!chart)
		throw new Error(
			`<${component}> declares itself in a chart: place it inside a <ChartContainer>.`
		);
	return chart;
}

/** Set by `ChartCell`: what its canvas draws (`DeclarationRegistry.forCell`). */
export const CELL_DECLARATIONS = 'cell-declarations';
/**
 * Set by `ChartContainer`: its children, which the chart's canvas renders. Any
 * `WebGPUCanvas` in the chart without a `facetIndex` renders them, so a chart
 * has exactly one such canvas: a `canvas` snippet holds a single one.
 */
export const CHART_CHILDREN = 'chart-children';

/** A chart's children, as its canvas renders them (`WebGPUCanvas`). */
export interface ChartChildren {
	/** The children, inside their `DeclarationScope`; none when the chart has none. */
	readonly snippet: Snippet | undefined;
}

export interface DeclarationScopeContext {
	readonly cellId: string | null;
}

export class DeclarationRegistry {
	declarations = $state<ChartDeclaration[]>([]);

	register(declaration: ChartDeclaration): () => void {
		this.declarations = [...this.declarations, declaration];
		return () => {
			this.declarations = this.declarations.filter((d) => d !== declaration);
		};
	}

	/** What one cell draws: the declarations for every cell, and its own. */
	forCell(cellId: string): CellDeclarations {
		return new CellDeclarations(this, cellId);
	}

	/**
	 * The chart's legends at `position`, in registration order. A legend is the
	 * chart's, not a cell's: the chart renders each one once. Only a chart's
	 * child declares one (Legend); in a per-cell snippet it renders in place.
	 */
	legends(position: LegendPosition): LegendDeclaration[] {
		const out: LegendDeclaration[] = [];
		for (const d of this.declarations) {
			if (d.kind === 'legend' && d.spec.position === position) out.push(d.spec);
		}
		return out;
	}
}

/** One cell's view of the registry. Filters on read, so it follows the registry. */
export class CellDeclarations {
	constructor(
		private readonly registry: DeclarationRegistry,
		readonly cellId: string
	) {}

	of<K extends DeclarationKind>(kind: K): Specs[K][] {
		const out: Specs[K][] = [];
		for (const d of this.registry.declarations) {
			if (d.kind === kind && (d.cellId === null || d.cellId === this.cellId)) {
				out.push(d.spec as Specs[K]);
			}
		}
		return out;
	}

	get axes(): AxisSpec[] {
		return this.of('axis');
	}

	get parallel(): ParallelAxesSpec[] {
		return this.of('parallel');
	}

	get frames(): FrameSpec[] {
		return this.of('frame');
	}

	/** The overlays this cell draws in `slot`, in draw order (orderOverlays). */
	overlays(slot: OverlaySlot): OverlaySpec[] {
		return orderOverlays(this.of('overlay').filter((o) => o.slot === slot));
	}
}

/**
 * Overlays in draw order: by zIndex, and by registration order among equals.
 * Registration order alone is not stable: an overlay in a toggled {#if}
 * registers again at the end, and a chart's children register once its canvas
 * is ready, after the declarations in its snippets. A zIndex is the only
 * guaranteed order. A new array; the specs themselves, so a keyed {#each}
 * keeps each overlay mounted.
 */
export function orderOverlays(overlays: readonly OverlaySpec[]): OverlaySpec[] {
	return overlays
		.map((o, i) => [o, i] as const)
		.sort(([a, i], [b, j]) => a.zIndex - b.zIndex || i - j)
		.map(([o]) => o);
}

/**
 * Declare an SVG overlay in the chart this component is placed in: `snippet`
 * renders in every cell's foreground SVG (or the cell its scope names), in
 * `slot`, with the cell's chart context. `options` may hold getters (it is read
 * on every use). Call during component initialisation.
 */
export function declareOverlay(
	snippet: Snippet<[ChartContext]>,
	options: { readonly slot: OverlaySlot; readonly zIndex?: number }
): void {
	// Read through the options on every use, so options given as getters over
	// props (SvgLayer's clip and zIndex) move and reorder the overlay live.
	declareInChart('overlay', {
		snippet,
		get slot() {
			return options.slot;
		},
		get zIndex() {
			return options.zIndex ?? 0;
		}
	});
}

/**
 * Declare a legend in the chart this component is placed in: the chart renders
 * `snippet` once, at `options.position` (read on every use, so it may be a
 * getter over a prop). Call during component initialisation.
 */
export function declareLegend(
	snippet: Snippet,
	options: { readonly position: LegendPosition }
): void {
	declareInChart('legend', {
		snippet,
		get position() {
			return options.position;
		}
	});
}

/**
 * Declare `spec` in the chart this component is placed in, for the cell its
 * scope names (or every cell), until the component is destroyed. Call during
 * component initialisation.
 *
 * Outside a chart: a declaration that only declares (an axis, Frame, an
 * overlay) declares nothing and draws nothing, as its SVG ancestor did; one
 * that needs the chart to work (a Toggle: its registrations name the chart)
 * throws, through getDeclarationChart, since it could never do anything there.
 */
export function declareInChart<K extends DeclarationKind>(kind: K, spec: Specs[K]): void {
	const registry = getContext<DeclarationRegistry | undefined>(DECLARATION_REGISTRY);
	const scope = getContext<DeclarationScopeContext | undefined>(DECLARATION_SCOPE);
	const unregister = registry?.register({
		kind,
		spec,
		cellId: scope?.cellId ?? null
	} as ChartDeclaration);
	onDestroy(() => unregister?.());
}
