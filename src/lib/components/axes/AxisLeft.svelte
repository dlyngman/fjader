<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { ContinuousScaleState } from '$lib/types';

	interface Props {
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
	}

	let { ticksNumber = 5, tickFormat = null }: Props = $props();
	const c = getContext<ChartContext>('chart');

	// Propagate custom format to scale state once it exists (for MarginLabel, tooltips, etc.)
	$effect(() => {
		const s = c.yScaleState;
		if (tickFormat && s && s.scaleType !== 'band')
			(s as ContinuousScaleState).setCustomFormat(tickFormat);
	});

	// Continuous scales (linear, time): use scaleState.getTicks()
	const continuousTicks = $derived(
		c.yScaleState?.getTicks ? c.yScaleState.getTicks(ticksNumber) : []
	);

	// Band scales: the categories on screen NOW, at their current fractional slots,
	// rather than the domain. Mid-transition a label travels with its bar, and a
	// leaving category keeps its label, fading, until its bar is gone.
	const bandTicks = $derived(
		c.scaleTypes?.y === 'band' && c.yScaleState ? (c.yScaleState as BandScaleState).bandTicks() : []
	);

	// Unified formatter interface - all scale states have tickFormat()
	const tickFormatter = $derived(c.yScaleState?.tickFormat ? c.yScaleState.tickFormat() : String);
</script>

{#if c.isReady && c.scaleTypes}
	<g class="axis">
		{#if c.scaleTypes.y !== 'band' && c.yScale}
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
			{@const bandState = c.yScaleState as BandScaleState}
			{#each bandTicks as tick (tick.key)}
				{@const tickY = bandState.tickPosition(tick.key, c.innerHeight, 'y')}
				<g opacity={bandState.tickOpacity(tick.key)}>
					<g class:tick-dimmed={bandState.isTickDimmed(tick)}>
						<line x1={0} x2={-6} y1={tickY} y2={tickY} />
						<text text-anchor="end" dominant-baseline="middle" x={-9} y={tickY}>
							{tick.value}
						</text>
					</g>
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
		stroke: var(--diveplot-text-secondary, #6b7280);
	}

	text {
		fill: var(--diveplot-text-secondary, #6b7280);
		font-family: var(--diveplot-font, system-ui, sans-serif);
		font-size: 10px;
	}

	.tick-dimmed {
		opacity: 0.25;
		transition: opacity 0.15s ease;
	}
</style>
