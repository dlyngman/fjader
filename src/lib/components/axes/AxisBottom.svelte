<script lang="ts">
	import { hasEntered } from '$lib/scales/entered';
	import { getContext } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import BandAxisTicks from './BandAxisTicks.svelte';
	import type { ContinuousScaleState } from '$lib/types';
	import type { TickEntry } from '$lib/scales/LinearScaleState.svelte';

	interface Props {
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
		/**
		 * Draw the scale's label as the axis title (default). `false` draws none; the
		 * label still names the scale, so charts sharing it still link their zoom.
		 */
		title?: boolean;
		/**
		 * Where along the axis the title sits: `'center'` (default), or at the plot's
		 * `'start'` (left) or `'end'` (right) edge.
		 */
		titleAnchor?: 'start' | 'center' | 'end';
	}

	let {
		ticksNumber = 5,
		tickFormat = null,
		title = true,
		titleAnchor = 'center'
	}: Props = $props();
	const c = getContext<ChartContext>('chart');

	// Propagate custom format to scale state once it exists (for MarginLabel, tooltips, etc.)
	$effect(() => {
		const s = c.xScaleState;
		if (tickFormat && s && s.scaleType !== 'band')
			(s as ContinuousScaleState).setCustomFormat(tickFormat);
	});

	// Continuous scales: the scale's tick frame, each tick with its place along
	// the plot and its opacity (at rest the live ticks, fully drawn; through a
	// discrete change, the old and new sets crossfading in place). None until
	// the scale has entered: before that its domain is a placeholder.
	const continuousTicks: readonly TickEntry[] = $derived.by(() => {
		const s = c.xScaleState;
		if (!s || c.scaleTypes?.x === 'band' || !hasEntered(s) || !('tickFrame' in s)) return [];
		return (s as ContinuousScaleState).tickFrame(ticksNumber);
	});
	/** Where a tick sits, in px: its place along the plot, under the domain drawn now. */
	const tickPx = (t: TickEntry) =>
		c.xScale!((c.xScaleState as ContinuousScaleState).valueAt(t.position));

	/**
	 * A tick's key: the incoming (or, at rest, the live) set by value, so a pan
	 * keeps each label's element; an outgoing set's by value and its frozen
	 * position, which does not move, and tells apart one value in two sets.
	 */
	const tickKey = (t: TickEntry) => (t.target ? `${t.value}` : `${t.value}@${t.position}`);

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
			{#each continuousTicks as tick (tickKey(tick))}
				{@const x = tickPx(tick)}
				<g opacity={tick.alpha}>
					<line x1={x} x2={x} y1={0} y2={5} />
					<text text-anchor="middle" {x} y={16}>
						{tickFormatter(tick.value)}
					</text>
				</g>
			{/each}
		{:else if c.scaleTypes.x === 'band' && c.xScale}
			<BandAxisTicks
				scale={c.xScaleState as BandScaleState}
				ticks={bandTicks}
				rangeSize={c.innerWidth}
				axis="x"
				tickLength={5}
				labelGap={16}
			/>
		{/if}

		{#if title && c.xScale}
			<text
				text-anchor={titleAnchor === 'start' ? 'start' : titleAnchor === 'end' ? 'end' : 'middle'}
				x={titleAnchor === 'start' ? 0 : titleAnchor === 'end' ? c.innerWidth : c.innerWidth / 2}
				y={28}
			>
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
