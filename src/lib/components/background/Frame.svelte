<script>
	import { getContext } from 'svelte';

	let { ticksNumber = 5 } = $props();
	const c = getContext('chart');
	
</script>

{#if c.xScale && c.yScale && c.innerHeight && c.innerWidth}
	<g class="frame">
		<line x1={0} x2={0} y1={0} y2={c.innerHeight} />
		<line x1={0} x2={c.innerWidth} y1={0} y2={0} />
    	<line x1={0} x2={c.innerWidth} y1={c.innerHeight} y2={c.innerHeight} />
		<line x1={c.innerWidth} x2={c.innerWidth} y1={0} y2={c.innerHeight} />
  </g>
{/if}

<style>
	line {
		stroke: var(--text-muted);
	}
</style>
