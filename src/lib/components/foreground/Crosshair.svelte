<script>
	import { getContext } from 'svelte';

	let { show = 'both' } = $props();

	const c = getContext('chart');
	
</script>

{#if c.xScale && c.yScale && c.innerHeight && c.innerWidth}
	<g class="crosshair">
		{#if c.currentXScreenPoint && ((show === 'both') || (show === 'x'))}
			<line x1={c.currentXScreenPoint} y1={c.innerHeight} x2={c.currentXScreenPoint} y2={0} />
		{/if}
		{#if c.currentYScreenPoint && ((show === 'both') || (show === 'y'))}
			<line x1={0} y1={c.currentYScreenPoint} x2={c.innerWidth} y2={c.currentYScreenPoint} />
		{/if}
	</g>
{/if}

<style>
	line {
		stroke: var(--text-muted);
	}
</style>
