<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import BandAxisTicks from './BandAxisTicks.svelte';
	import type { ContinuousScaleState } from '$lib/types';
	import { categoryLabel } from '$lib/query-engine/categorical-identity';
	import { clearTitleOffset, textWidth } from './axis-title';

	interface Props {
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
		/**
		 * Draw the scale's label as the axis title (default). `false` draws none; the
		 * label still names the scale, so charts sharing it still link their zoom.
		 */
		title?: boolean;
		/**
		 * How far left of the axis the title sits, in px (default 32), or `'auto'`:
		 * clear of the widest tick label, as far as the chart's left margin allows.
		 */
		titleOffset?: number | 'auto';
	}

	let { ticksNumber = 5, tickFormat = null, title = true, titleOffset = 32 }: Props = $props();
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

	// The title's distance from the axis. Measured only for 'auto', from the labels
	// drawn (band labels once per distinct name, then cached).
	const titleX = $derived.by(() => {
		if (titleOffset !== 'auto') return titleOffset;
		let widest = 0;
		if (c.scaleTypes?.y === 'band') {
			for (const tick of bandTicks)
				widest = Math.max(widest, textWidth(String(categoryLabel(tick.value))));
		} else {
			for (const tick of continuousTicks)
				widest = Math.max(widest, textWidth(String(tickFormatter(tick))));
		}
		return clearTitleOffset(widest, c.margin.left);
	});
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
		{:else if c.scaleTypes.y === 'band' && c.yScale}
			<BandAxisTicks
				scale={c.yScaleState as BandScaleState}
				ticks={bandTicks}
				rangeSize={c.innerHeight}
				axis="y"
				dir={-1}
				textAnchor="end"
			/>
		{/if}

		{#if title && c.yScale}
			<text
				text-anchor="middle"
				transform={`translate(${-titleX}, ${c.innerHeight / 2}) rotate(-90)`}
			>
				{c.yLabel}
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
