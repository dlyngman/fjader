<script lang="ts">
	/**
	 * MarginLabel's drawing in one cell: rendered by each cell from the overlay MarginLabel
	 * declares (charts/declarations), so it reads that cell's chart context.
	 */
	import { getContext } from 'svelte';
	import type { ChartContext, ContinuousScaleState } from '$lib/types';

	interface Props {
		show?: 'both' | 'x' | 'y';
	}

	let { show = 'both' }: Props = $props();

	const c = getContext<ChartContext>('chart');

	// A value or a screen position of 0 is valid: only null and NaN are not.
	const isValid = (v: unknown): v is number =>
		v !== null && v !== undefined && !Number.isNaN(v as number);

	const xFormatter = $derived(
		c.xScaleState && c.xScaleState.scaleType !== 'band'
			? (v: unknown) => (c.xScaleState as ContinuousScaleState).formatValue(v as number)
			: String
	);
	const yFormatter = $derived(
		c.yScaleState && c.yScaleState.scaleType !== 'band'
			? (v: unknown) => (c.yScaleState as ContinuousScaleState).formatValue(v as number)
			: String
	);
</script>

{#if c.xScale && c.yScale && c.innerHeight && c.innerWidth}
	<g class="margin-label">
		{#if isValid(c.currentXScreenPoint) && isValid(c.currentXDataPoint) && (show === 'both' || show === 'x') && c.active}
			<text text-anchor="middle" x={c.currentXScreenPoint} y={-5}>
				{xFormatter(c.currentXDataPoint)}
			</text>
		{/if}
		{#if isValid(c.currentYScreenPoint) && isValid(c.currentYDataPoint) && (show === 'both' || show === 'y') && c.active}
			<text
				text-anchor="start"
				dominant-baseline="middle"
				x={c.innerWidth + 5}
				y={c.currentYScreenPoint}
			>
				{yFormatter(c.currentYDataPoint)}
			</text>
		{/if}
	</g>
{/if}

<style>
	/* Drawn over the plot and its margins, GPU axis labels included: a halo in
	   the background colour keeps the readout legible where they cross. */
	text {
		fill: var(--fjader-text-secondary, #6b7280);
		font-family: var(--fjader-font, system-ui, sans-serif);
		font-size: 10px;
		paint-order: stroke;
		stroke: var(--fjader-bg, #ffffff);
		stroke-width: 3px;
		stroke-linejoin: round;
	}
</style>
