<script>
	import { format } from 'd3-format';
	import { getContext } from 'svelte';

	let { ticksNumber = 5 } = $props();
	const c = getContext('chart');

	const isTimeScale = $derived(c.scaleTypes?.y === 'time');
	// For time scales, use scaleState.getTicks() for calendar-nice ticks
	const continuousTicks = $derived(
		isTimeScale && c.yScaleState?.getTicks
			? c.yScaleState.getTicks(ticksNumber)
			: (c.yScale?.ticks(ticksNumber) ?? [])
	);
	const tickFormatter = $derived(
		isTimeScale && c.yScaleState?.tickFormat ? c.yScaleState.tickFormat() : format('~s')
	);
</script>

{#if c.isReady}
	<g class="axis">
		{#if c.scaleTypes.y === 'linear' || c.scaleTypes.y === 'time'}
			{#each continuousTicks as tick, i (i)}
				<line x1={0} x2={-6} y1={c.yScale(tick)} y2={c.yScale(tick)} />

				<text text-anchor="end" dominant-baseline="middle" x={-9} y={c.yScale(tick)}>
					{tickFormatter(tick)}
				</text>
			{/each}

			<text text-anchor="middle" transform={`translate(-32, ${c.innerHeight / 2}) rotate(-90)`}>
				{c.yLabel}
			</text>
		{:else if c.scaleTypes.y === 'band'}
			{#each c.yScale.domain() as tick (tick)}
				{@const tickY = c.yScale(tick)}
				<line
					x1={0}
					x2={-6}
					y1={tickY + c.yScale.bandwidth() / 2}
					y2={tickY + c.yScale.bandwidth() / 2}
				/>

				<text
					text-anchor="end"
					dominant-baseline="middle"
					x={-9}
					y={tickY + c.yScale.bandwidth() / 2}
				>
					<!-- {formatter(tick)} -->
					{tick}
					<!-- {format("~s")(tick)} -->
				</text>
			{/each}

			<text text-anchor="middle" transform={`translate(-32, ${c.innerHeight / 2}) rotate(-90)`}>
				{c.yLabel}
			</text>
		{/if}
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
