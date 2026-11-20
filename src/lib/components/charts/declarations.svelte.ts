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
import { getContext, onDestroy } from 'svelte';
import type { AxisSpec, ParallelAxesSpec } from '../axes/axis-spec';

/** A plot border around the inner plot area (`<Frame/>`). */
export interface FrameSpec {
	readonly id: string;
}

interface Specs {
	axis: AxisSpec;
	parallel: ParallelAxesSpec;
	frame: FrameSpec;
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
