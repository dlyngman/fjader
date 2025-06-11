<script>
	import { format } from 'd3-format';
	import { getContext } from 'svelte';

	let { show = 'both' } = $props();

	const c = getContext('chart');

	const formatter = format(".3s")	
</script>

{#if c.xScale && c.yScale && c.innerHeight && c.innerWidth}
	<g class="margin-label">
		{#if c.currentXScreenPoint && c.currentXDataPoint && ((show === 'both') || (show === 'x')) && c.active}
			<text
				text-anchor="middle"
				x={c.currentXScreenPoint}
				y={-5}>
				{formatter(c.currentXDataPoint)}
			</text>
			<!-- <line x1={c.currentXPos} y1={c.innerHeight} x2={c.currentXPos} y2={0} /> -->
		{/if}
		{#if c.currentYScreenPoint && c.currentYDataPoint && ((show === 'both') || (show === 'y')) && c.active}
			<text
				text-anchor="start"
				dominant-baseline="middle"
				x={c.innerWidth + 5}
				y={c.currentYScreenPoint}>
				{formatter(c.currentYDataPoint)}
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
