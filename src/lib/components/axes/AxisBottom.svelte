<script>
	import { format } from 'd3-format';
	import { getContext } from 'svelte';

	let { ticksSpace = 100, labelsSpace = 100 } = $props();
	const c = getContext('chart');

	const labelsNumber = 4;
	const ticksNumber = 5;

	const formatter = $derived(c.xScale.tickFormat());
	// tick labels vs ticks, major vs minor?
</script>

<!-- {#if c.xScale && c.innerHeight && c.innerWidth && c.scalesReady} -->
{#if c.isReady}
	<g class="axis" transform="translate(0 , {c.innerHeight})">
		<!-- <line x1={0} y1={0} x2={innerWidth} y2={0} /> -->
		<!-- {#each c.xScale.ticks(ticksNumber) as tick (tick)} -->
		{#each c.xScale.ticks(ticksNumber) as tick, i (i)}
			<line x1={c.xScale(tick)} x2={c.xScale(tick)} y1={0} y2={5} />

			<text text-anchor="middle" x={c.xScale(tick)} y={16}>
				{format('~s')(tick)}
			</text>
		{/each}

		<text text-anchor="middle" x={c.innerWidth / 2} y={28}>
			{c.xLabel}
		</text>
	</g>
{/if}

<style>
	line {
		stroke: var(--text-secondary);
	}

	text {
		fill: var(--text-secondary);
		font-size: 10px;
	}
</style>
