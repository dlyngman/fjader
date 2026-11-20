/**
 * The GPU-drawn guide declarations a chart cell renders (axes, parallel axes,
 * and plot border frames).
 *
 * `<AxisLeft/>`, `<AxisBottom/>`, `<ParallelAxes/>` and `<Frame/>` declare
 * their settings here wherever they are placed, and the cell's `WebGPUCanvas`
 * draws each registered declaration on the GPU.
 *
 * Stored as one `kind`-keyed list; the typed getters filter on read so Svelte
 * templates track `declarations` reactively and unit tests work identically in
 * Node.
 *
 * One registry per chart cell (ChartCell), so a facet grid's cells draw their
 * own axes and plot borders.
 */

/** One axis's settings, read through getters so they stay the component's props. */
export interface AxisSpec {
	readonly id: string;
	readonly side: 'bottom' | 'left';
	readonly ticksNumber: number;
	readonly tickFormat: ((value: unknown) => string) | null;
	readonly title: boolean;
	/** Bottom: where along the axis the title sits. */
	readonly titleAnchor: 'start' | 'center' | 'end';
	/** Left: px from the axis, or `'auto'` (clear of the widest label). */
	readonly titleOffset: number | 'auto';
	/** Left: beside the labels, rotated, or above the plot. */
	readonly titlePlacement: 'side' | 'top';
}

/** A parallel coordinates chart's axes: one per column, each on its own scale. */
export interface ParallelAxesSpec {
	readonly id: string;
	readonly ticksNumber: number;
	readonly tickFormat: ((value: unknown) => string) | null;
}

/** A plot border around the inner plot area (`<Frame/>`). */
export interface FrameSpec {
	readonly id: string;
}

export type ChartDeclaration =
	| { readonly kind: 'axis'; readonly spec: AxisSpec }
	| { readonly kind: 'parallel'; readonly spec: ParallelAxesSpec }
	| { readonly kind: 'frame'; readonly spec: FrameSpec };

export const AXIS_REGISTRY = 'axis-registry';

/** An axis title as the axis renderer draws it. */
export interface AxisTitle {
	slot: number;
	/** bottom: 0 centre, 1 start, 2 end; left: 3 beside (rotated), 4 above. */
	mode: number;
	/** CSS pixels from the axis. */
	offset: number;
}

export class AxisRegistry {
	declarations = $state<ChartDeclaration[]>([]);

	get axes(): AxisSpec[] {
		return this.declarations
			.filter((d): d is Extract<ChartDeclaration, { kind: 'axis' }> => d.kind === 'axis')
			.map((d) => d.spec);
	}

	get parallel(): ParallelAxesSpec[] {
		return this.declarations
			.filter((d): d is Extract<ChartDeclaration, { kind: 'parallel' }> => d.kind === 'parallel')
			.map((d) => d.spec);
	}

	get frames(): FrameSpec[] {
		return this.declarations
			.filter((d): d is Extract<ChartDeclaration, { kind: 'frame' }> => d.kind === 'frame')
			.map((d) => d.spec);
	}

	registerDeclaration(decl: ChartDeclaration): () => void {
		this.declarations = [...this.declarations, decl];
		return () => {
			this.declarations = this.declarations.filter((d) => d !== decl);
		};
	}

	register(spec: AxisSpec): () => void {
		return this.registerDeclaration({ kind: 'axis', spec });
	}

	registerParallel(spec: ParallelAxesSpec): () => void {
		return this.registerDeclaration({ kind: 'parallel', spec });
	}

	registerFrame(spec: FrameSpec): () => void {
		return this.registerDeclaration({ kind: 'frame', spec });
	}
}
