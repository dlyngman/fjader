/**
 * What a chart draws because a component declared it, rather than rendered it
 * where it was placed: axes, parallel axes, the plot border.
 *
 * A declaration component (`AxisLeft`, `AxisBottom`, `ParallelAxes`, `Frame`)
 * registers its settings here, as getters over its props, and reads no chart
 * context where it is placed: what it needs per cell runs in the component the
 * cell draws it with (`GpuAxis`, `GpuParallelAxes`, `PlotBorderRenderer`, in
 * the cell's `WebGPUCanvas`).
 *
 * One registry per chart (`ChartContainer`). A declaration is for every cell
 * of the chart, or for one: `ChartCell` renders its per-cell snippets
 * (`background`, `foreground`, `interactors`, `overlay`) inside a
 * `DeclarationScope` naming the cell, so a facet grid whose snippets render
 * once per cell gets one declaration per cell, each drawn in its own cell.
 */
import { getContext, onDestroy, type Snippet } from 'svelte';
import type { AxisSpec, ParallelAxesSpec } from '../axes/axis-spec';
import type { ChartContext } from '$lib/types';

/** A plot border around the inner plot area (`<Frame/>`). */
export interface FrameSpec {
	readonly id: string;
}

/**
 * Where in a cell's foreground SVG an overlay draws: `clipped`, inside the plot
 * clip, under the hover dot and the hit target (Crosshair, AxisCenter,
 * SvgLayer); `margins`, unclipped, over the plot and its margins, taking no
 * pointer events (MarginLabel, SvgLayer clip={false}).
 */
export type OverlaySlot = 'clipped' | 'margins';

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

interface Specs {
	axis: AxisSpec;
	parallel: ParallelAxesSpec;
	frame: FrameSpec;
	overlay: OverlaySpec;
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
	/**
	 * Placed directly in a chart (`ChartContainer`'s children), not in one of
	 * its snippets. Read by the overlays that can't be placed there yet
	 * (`warnIfInChildren`).
	 */
	readonly inChildren: boolean;
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
 * For a component that renders its own SVG or HTML where it is placed (an
 * overlay: a crosshair, a brush, a toggle, a legend): warn when it is a direct
 * child of a chart. Children render inside the chart's canvas layer, where such
 * a component can't draw or take pointer events; it belongs in its snippet
 * until it is a declaration too. Call during component initialisation.
 */
export function warnIfInChildren(component: string, snippet: string): void {
	const scope = getContext<DeclarationScopeContext | undefined>(DECLARATION_SCOPE);
	if (!scope?.inChildren) return;
	console.warn(
		`fjader: <${component}> can't be a direct child of <ChartContainer> yet; ` +
			`place it in the chart's \`${snippet}\` snippet.`
	);
}

/**
 * Declare an SVG overlay in the chart this component is placed in: `snippet`
 * renders in every cell's foreground SVG (or the cell its scope names), in
 * `slot`, with the cell's chart context. Call during component initialisation.
 */
export function declareOverlay(
	snippet: Snippet<[ChartContext]>,
	options: { slot: OverlaySlot; zIndex?: number }
): void {
	declareInChart('overlay', { snippet, slot: options.slot, zIndex: options.zIndex ?? 0 });
}

/**
 * Declare `spec` in the chart this component is placed in, for the cell its
 * scope names (or every cell), until the component is destroyed. Call during
 * component initialisation. Outside a chart, nothing is declared.
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
