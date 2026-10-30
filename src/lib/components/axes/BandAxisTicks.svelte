<script lang="ts">
	import type { BandScaleState, BandTick } from '$lib/scales/BandScaleState.svelte';

	/**
	 * The labels on a band axis, wherever that axis is drawn.
	 *
	 * Three components rendered this: AxisBottom, AxisLeft and AxisCenter. The
	 * arithmetic was already shared — `tickPosition`, `tickOpacity` and
	 * `isTickDimmed` all live on the scale — so what was actually duplicated
	 * was the markup around it, and what differs between the three is a handful
	 * of numbers: which way the ticks point, how long they are, how far the
	 * label sits, and where it anchors.
	 *
	 * Those are props here, so the structure is written once. The structure is
	 * the part with the reasons attached: the keyed `{#each}` so a reorder
	 * MOVES a label rather than replacing it, the opacity wrapper the scale
	 * drives per frame so a label travels and fades with its bar, and the
	 * dimming class inside it so a selection does not fight the transition.
	 *
	 * A band label is positioned through `tickPosition`, which reads the
	 * category's CURRENT fractional slot, not through the d3 scale. The d3
	 * scale carries the settled domain, so a label placed by it jumps to its
	 * final column on the frame a reorder lands while its bar is still
	 * travelling. That was the last consumer to have this bug and it is worth
	 * not reintroducing.
	 */
	interface Props {
		scale: BandScaleState;
		/** What the scale says is on screen now, including anything leaving. */
		ticks: BandTick[];
		/** The length of the axis: inner width for x, inner height for y. */
		rangeSize: number;
		/** Which axis the categories run along. */
		axis: 'x' | 'y';
		/** The cross-axis coordinate ticks start from. */
		base?: number;
		/** Which way ticks and labels point away from `base`. */
		dir?: 1 | -1;
		tickLength?: number;
		/** How far the label sits from `base`, measured the same way. */
		labelGap?: number;
		textAnchor?: 'start' | 'middle' | 'end';
	}

	let {
		scale,
		ticks,
		rangeSize,
		axis,
		base = 0,
		dir = 1,
		tickLength = 6,
		labelGap = 9,
		textAnchor = 'middle'
	}: Props = $props();

	const tickEnd = $derived(base + dir * tickLength);
	const labelAt = $derived(base + dir * labelGap);
</script>

{#each ticks as tick (tick.key)}
	{@const pos = scale.tickPosition(tick.key, rangeSize, axis)}
	<g opacity={scale.tickOpacity(tick.key)}>
		<g class:tick-dimmed={scale.isTickDimmed(tick)}>
			{#if axis === 'x'}
				<line x1={pos} x2={pos} y1={base} y2={tickEnd} />
				<text text-anchor={textAnchor} x={pos} y={labelAt}>
					{tick.value}
				</text>
			{:else}
				<line x1={base} x2={tickEnd} y1={pos} y2={pos} />
				<text text-anchor={textAnchor} dominant-baseline="middle" x={labelAt} y={pos}>
					{tick.value}
				</text>
			{/if}
		</g>
	</g>
{/each}

<style>
	line {
		stroke: var(--fjader-text-secondary, #6b7280);
	}

	text {
		fill: var(--fjader-text-secondary, #6b7280);
		font-family: var(--fjader-font, system-ui, sans-serif);
		font-size: 10px;
	}

	.tick-dimmed {
		opacity: 0.25;
		transition: opacity 0.15s ease;
	}
</style>
