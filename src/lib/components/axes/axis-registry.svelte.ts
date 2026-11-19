/**
 * The axes a chart cell draws, as its axis components declare them.
 *
 * `<AxisLeft/>` and `<AxisBottom/>` are placed in the chart's `background`
 * snippet, which is SVG, outside the canvas, but the axes draw on the GPU, in
 * the canvas, in the chart's margins. So the components DECLARE: each
 * registers its settings here, and the cell's WebGPUCanvas draws whatever is
 * registered (GpuAxis). A declaration works wherever it is placed.
 *
 * `<ParallelAxes/>` declares the same way: one axis per column of a parallel
 * coordinates chart, drawn by GpuParallelAxes.
 *
 * One registry per chart cell (ChartCell), so a facet grid's cells draw their
 * own axes.
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
	axes = $state<AxisSpec[]>([]);

	register(spec: AxisSpec): () => void {
		this.axes = [...this.axes, spec];
		return () => {
			this.axes = this.axes.filter((s) => s !== spec);
		};
	}

	parallel = $state<ParallelAxesSpec[]>([]);

	registerParallel(spec: ParallelAxesSpec): () => void {
		this.parallel = [...this.parallel, spec];
		return () => {
			this.parallel = this.parallel.filter((s) => s !== spec);
		};
	}
}
