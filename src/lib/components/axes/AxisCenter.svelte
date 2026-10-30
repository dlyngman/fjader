<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import BandAxisTicks from './BandAxisTicks.svelte';
	import type { ContinuousScaleState } from '$lib/types';

	interface Props {
		anchor?: number;
		fixed?: boolean;
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
		labelSide?: 'left' | 'right';
	}

	let {
		anchor = 0,
		fixed = false,
		ticksNumber = 5,
		tickFormat = null,
		labelSide = 'left'
	}: Props = $props();
	const c = getContext<ChartContext>('chart');

	// Propagate custom format to scale state once it exists
	$effect(() => {
		const s = c.yScaleState;
		if (tickFormat && s && s.scaleType !== 'band')
			(s as ContinuousScaleState).setCustomFormat(tickFormat);
	});

	// Compute axis x position: data-anchored or visually fixed
	const axisX = $derived(fixed ? c.innerWidth / 2 : (c.xScale?.(anchor) ?? 0));

	// Hide when off-screen (only relevant for data-anchored mode)
	const visible = $derived(fixed || (axisX >= 0 && axisX <= c.innerWidth));

	// Tick direction: -1 for left labels, +1 for right labels
	const tickDir = $derived(labelSide === 'right' ? 1 : -1);
	const textAnchor = $derived(labelSide === 'right' ? 'start' : 'end');

	// Continuous scales (linear, time): use scaleState.getTicks()
	const continuousTicks = $derived(
		c.yScaleState?.getTicks ? c.yScaleState.getTicks(ticksNumber) : []
	);

	// Band scales: the categories on screen NOW, at their current fractional slots —
	// see BandScaleState.bandTicks.
	const bandTicks = $derived(
		c.scaleTypes?.y === 'band' && c.yScaleState ? (c.yScaleState as BandScaleState).bandTicks() : []
	);

	// Unified formatter interface
	const tickFormatter = $derived(c.yScaleState?.tickFormat ? c.yScaleState.tickFormat() : String);
</script>

{#if c.isReady && c.scaleTypes && visible}
	<g class="axis axis-center" clip-path={c.clipPathUrl}>
		<!-- Axis line -->
		<line class="axis-line" x1={axisX} x2={axisX} y1={0} y2={c.innerHeight} />

		{#if c.scaleTypes.y !== 'band' && c.yScale}
			{#each continuousTicks as tick, i (i)}
				{@const tickY = c.yScale(tick)}
				<line x1={axisX} x2={axisX + tickDir * 6} y1={tickY} y2={tickY} />
				<text text-anchor={textAnchor} dominant-baseline="middle" x={axisX + tickDir * 9} y={tickY}>
					{tickFormatter(tick)}
				</text>
			{/each}
		{:else if c.scaleTypes.y === 'band' && c.yScale}
			<BandAxisTicks
				scale={c.yScaleState as BandScaleState}
				ticks={bandTicks}
				rangeSize={c.innerHeight}
				axis="y"
				base={axisX}
				dir={tickDir}
				{textAnchor}
			/>
		{/if}
	</g>
{/if}

<style>
	.axis-line {
		stroke: var(--fjader-text-secondary, #6b7280);
	}

	line {
		stroke: var(--fjader-text-secondary, #6b7280);
	}

	text {
		fill: var(--fjader-text-secondary, #6b7280);
		font-family: var(--fjader-font, system-ui, sans-serif);
		font-size: 10px;
	}
</style>
