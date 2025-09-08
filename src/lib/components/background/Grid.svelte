<script>
	import { getContext } from 'svelte';

	let { show = 'both', ticksNumber = 5,  } = $props();
	const c = getContext('chart');
	
	// console.log(c.yScale.ticks(ticksNumber))
</script>

{#if c.xScale && c.yScale && c.innerHeight && c.innerWidth}
	<g class="axis-grid">
		<!-- <line x1={0} y1={c.innerHeight} x2={0} y2={0} /> -->
		{#if ((show === 'both') || (show === 'y'))}		
			<!-- {#each c.yScale.ticks(ticksNumber) as tick (tick)} -->
			{#each c.yScale.ticks(ticksNumber) as tick, i (i)}
				<line x1={0} x2={c.innerWidth} y1={c.yScale(tick)} y2={c.yScale(tick)} />
			{/each}
		{/if}
		{#if ((show === 'both') || (show === 'x'))}
			<!-- {#each c.xScale.ticks(ticksNumber) as tick (tick)} -->
			{#each c.xScale.ticks(ticksNumber) as tick, i (i)}
				<line x1={c.xScale(tick)} x2={c.xScale(tick)} y1={0} y2={c.innerHeight} />
			{/each}
		{/if}
	</g>
{/if}

<style>
	line {
		stroke: var(--text-muted);
	}
</style>
