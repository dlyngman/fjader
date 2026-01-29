<script>
	import { format } from 'd3-format';
	import { getContext } from 'svelte';

	let { show = 'both' } = $props();

	const c = getContext('chart');

	const numericFormatter = format('.3s');
	const xFormatter = $derived(
		c.scaleTypes?.x === 'time' && c.xScaleState?.tickFormat
			? c.xScaleState.tickFormat()
			: numericFormatter
	);
	const yFormatter = $derived(
		c.scaleTypes?.y === 'time' && c.yScaleState?.tickFormat
			? c.yScaleState.tickFormat()
			: numericFormatter
	);
</script>

{#if c.xScale && c.yScale && c.innerHeight && c.innerWidth}
	<g class="margin-label">
		{#if c.currentXScreenPoint && c.currentXDataPoint && (show === 'both' || show === 'x') && c.active}
			<text text-anchor="middle" x={c.currentXScreenPoint} y={-5}>
				{xFormatter(c.currentXDataPoint)}
			</text>
		{/if}
		{#if c.currentYScreenPoint && c.currentYDataPoint && (show === 'both' || show === 'y') && c.active}
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
	text {
		fill: var(--text-secondary);
		font-size: 10px;
	}
</style>
