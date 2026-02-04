<script>
	import { getContext } from 'svelte';

	let { ticksNumber = 5 } = $props();
	const c = getContext('chart');

	// Continuous scales (linear, time): use scaleState.getTicks()
	const continuousTicks = $derived(
		c.yScaleState?.getTicks ? c.yScaleState.getTicks(ticksNumber) : []
	);

	// Band scales: use D3 scale's domain() for category strings (needed for positioning)
	const bandTicks = $derived(c.yScale?.domain ? c.yScale.domain() : []);

	// Unified formatter interface - all scale states have tickFormat()
	const tickFormatter = $derived(c.yScaleState?.tickFormat ? c.yScaleState.tickFormat() : String);
</script>

{#if c.isReady}
	<g class="axis">
		{#if c.scaleTypes.y === 'linear' || c.scaleTypes.y === 'time'}
			<!-- Continuous scales: direct positioning -->
			{#each continuousTicks as tick, i (i)}
				<line x1={0} x2={-6} y1={c.yScale(tick)} y2={c.yScale(tick)} />

				<text text-anchor="end" dominant-baseline="middle" x={-9} y={c.yScale(tick)}>
					{tickFormatter(tick)}
				</text>
			{/each}

			<text text-anchor="middle" transform={`translate(-32, ${c.innerHeight / 2}) rotate(-90)`}>
				{c.yLabel}
			</text>
		{:else if c.scaleTypes.y === 'band' && c.yScale}
			<!-- Band scales: centered positioning -->
			{#each bandTicks as tick (tick)}
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
					{tick}
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
