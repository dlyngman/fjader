<script>
	import { getContext } from 'svelte';

	let { ticksNumber = 5, tickFormat = null } = $props();
	const c = getContext('chart');

	// Propagate custom format to scale state once it exists (for MarginLabel, tooltips, etc.)
	$effect(() => {
		if (tickFormat && c.yScaleState?.setCustomFormat) c.yScaleState.setCustomFormat(tickFormat);
	});

	// Continuous scales (linear, time): use scaleState.getTicks()
	const continuousTicks = $derived(
		c.yScaleState?.getTicks ? c.yScaleState.getTicks(ticksNumber) : []
	);

	// Band scales: use D3 scale's domain() for category strings (needed for positioning)
	const bandTicks = $derived(c.yScale?.domain ? c.yScale.domain() : []);

	// Unified formatter interface - all scale states have tickFormat()
	const tickFormatter = $derived(c.yScaleState?.tickFormat ? c.yScaleState.tickFormat() : String);
</script>

{#if c.isReady && c.scaleTypes}
	<g class="axis">
		{#if (c.scaleTypes.y === 'linear' || c.scaleTypes.y === 'time') && c.yScale}
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
				<g class:tick-dimmed={c.yScaleState.activeValues != null && !c.yScaleState.isActive(tick)}>
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
				</g>
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

	.tick-dimmed {
		opacity: 0.25;
		transition: opacity 0.15s ease;
	}
</style>
