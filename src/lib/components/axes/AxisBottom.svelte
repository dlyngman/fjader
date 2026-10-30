<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import BandAxisTicks from './BandAxisTicks.svelte';
	import type { ContinuousScaleState } from '$lib/types';

	interface Props {
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
	}

	let { ticksNumber = 5, tickFormat = null }: Props = $props();
	const c = getContext<ChartContext>('chart');

	// Propagate custom format to scale state once it exists (for MarginLabel, tooltips, etc.)
	$effect(() => {
		const s = c.xScaleState;
		if (tickFormat && s && s.scaleType !== 'band')
			(s as ContinuousScaleState).setCustomFormat(tickFormat);
	});

	// Continuous scales (linear, time): use scaleState.getTicks()
	const continuousTicks = $derived(
		c.xScaleState?.getTicks ? c.xScaleState.getTicks(ticksNumber) : []
	);

	// Band scales: the categories on screen NOW, at their current fractional slots,
	// rather than the domain. Mid-transition a label travels with its bar, and a
	// leaving category keeps its label, fading, until its bar is gone.
	const bandTicks = $derived(
		c.scaleTypes?.x === 'band' && c.xScaleState ? (c.xScaleState as BandScaleState).bandTicks() : []
	);

	// Unified formatter interface - all scale states have tickFormat()
	const tickFormatter = $derived(c.xScaleState?.tickFormat ? c.xScaleState.tickFormat() : String);
</script>

{#if c.isReady && c.scaleTypes}
	<g class="axis" transform="translate(0 , {c.innerHeight})">
		{#if c.scaleTypes.x !== 'band' && c.xScale}
			<!-- Continuous scales: direct positioning -->
			{#each continuousTicks as tick, i (i)}
				<line x1={c.xScale(tick)} x2={c.xScale(tick)} y1={0} y2={5} />

				<text text-anchor="middle" x={c.xScale(tick)} y={16}>
					{tickFormatter(tick)}
				</text>
			{/each}

			<text text-anchor="middle" x={c.innerWidth / 2} y={28}>
				{c.xLabel}
			</text>
		{:else if c.scaleTypes.x === 'band' && c.xScale}
			<BandAxisTicks
				scale={c.xScaleState as BandScaleState}
				ticks={bandTicks}
				rangeSize={c.innerWidth}
				axis="x"
				tickLength={5}
				labelGap={16}
			/>

			<text text-anchor="middle" x={c.innerWidth / 2} y={28}>
				{c.xLabel}
			</text>
		{/if}
	</g>
{/if}

<style>
	line {
		stroke: var(--fjader-text-secondary, #6b7280);
	}

	text {
		fill: var(--fjader-text-secondary, #6b7280);
		font-family: var(--fjader-font, system-ui, sans-serif);
		font-size: 10px;
	}
</style>
