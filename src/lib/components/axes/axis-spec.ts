/**
 * What an axis declaration carries (`AxisLeft`, `AxisBottom`, `ParallelAxes`)
 * and what the axis renderer is handed for its title. The declarations
 * themselves live in the chart's declaration registry
 * (`charts/declarations.svelte.ts`).
 */

/**
 * A tick format: a function, or a d3-format specifier (`'+%'`, `',.0f'`) the
 * scale applies with the precision its tick step needs.
 */
export type TickFormat = string | ((value: unknown) => string);

/** One axis's settings, read through getters so they stay the component's props. */
export interface AxisSpec {
	readonly id: string;
	readonly side: 'bottom' | 'left';
	readonly ticksNumber: number;
	readonly tickFormat: TickFormat | null;
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

/** An axis title as the axis renderer draws it. */
export interface AxisTitle {
	slot: number;
	/** bottom: 0 centre, 1 start, 2 end; left: 3 beside (rotated), 4 above. */
	mode: number;
	/** CSS pixels from the axis. */
	offset: number;
}
