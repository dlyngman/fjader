<script>
	import { getContext } from 'svelte';

	let { show = 'both' } = $props();

	const c = getContext('chart');

	const xFormatter = $derived(
		c.xScaleState?.formatValue ? (v) => c.xScaleState.formatValue(v) : String
	);
	const yFormatter = $derived(
		c.yScaleState?.formatValue ? (v) => c.yScaleState.formatValue(v) : String
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
