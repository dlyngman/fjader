<script>
	import { format } from 'd3-format';
	import { getContext } from 'svelte';

	let { ticksSpace = 100, labelsSpace = 100 } = $props();
	const c = getContext('chart');

	const labelsNumber = 4;
	const ticksNumber = 5;

	const isTimeScale = $derived(c.scaleTypes?.x === 'time');
	// For time scales, use scaleState.getTicks() for calendar-nice ticks
	// For linear, use d3 scale's ticks()
	const ticks = $derived(
		isTimeScale && c.xScaleState?.getTicks
			? c.xScaleState.getTicks(ticksNumber)
			: c.xScale?.ticks(ticksNumber) ?? []
	);
	const tickFormatter = $derived(
		isTimeScale && c.xScaleState?.tickFormat ? c.xScaleState.tickFormat() : format('~s')
	);
</script>

{#if c.isReady}
	<g class="axis" transform="translate(0 , {c.innerHeight})">
		{#each ticks as tick, i (i)}
			<line x1={c.xScale(tick)} x2={c.xScale(tick)} y1={0} y2={5} />

			<text text-anchor="middle" x={c.xScale(tick)} y={16}>
				{tickFormatter(tick)}
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
