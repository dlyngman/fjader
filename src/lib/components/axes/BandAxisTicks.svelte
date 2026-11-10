<script lang="ts">
	import { getContext } from 'svelte';
	import type { BandScaleState, BandTick } from '$lib/scales/BandScaleState.svelte';
	import type { ChartContext } from '$lib/types';
	import { categoryLabel } from '$lib/query-engine/categorical-identity';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	/**
	 * The labels on a band axis, wherever that axis is drawn.
	 *
	 * Three components rendered this: AxisBottom, AxisLeft and AxisCenter. The
	 * arithmetic was already shared — `tickPosition` and `tickOpacity` live on
	 * the scale — so what was actually duplicated
	 * was the markup around it, and what differs between the three is a handful
	 * of numbers: which way the ticks point, how long they are, how far the
	 * label sits, and where it anchors.
	 *
	 * Those are props here, so the structure is written once. The structure is
	 * the part with the reasons attached: the keyed `{#each}` so a reorder
	 * MOVES a label rather than replacing it, and the opacity wrapper the scale
	 * drives per frame so a label travels, enters, leaves and dims for a
	 * selection with its bar, all on the scale's clocks.
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

	const chart = getContext<ChartContext | undefined>('chart');
	const filterGroups = getContext<FilterGroupRegistry | undefined>('filter-groups');

	/**
	 * The filter groups whose selection the labels show: those of the chart's
	 * marks. A selection dims the axis's marks in their own group, so a label
	 * dims when any of those groups dims its category; a background mark in a
	 * group with nothing selected changes nothing.
	 */
	const groups = $derived.by(() => {
		if (!chart || !filterGroups) return [];
		const indices: number[] = [];
		for (const entry of chart.config.entries.values()) {
			// A 'filter' mark never dims; its labels follow it.
			if (entry.selectionResponse === 'filter') continue;
			const index = filterGroups.get(entry.selection).index;
			if (!indices.includes(index)) indices.push(index);
		}
		return indices;
	});

	/**
	 * The field the axis's selection is kept under: its identity key, or its
	 * column before. As for the legend, the two differ for a computed field,
	 * so its labels briefly lose their dimming while a reload empties identity.
	 */
	const key = $derived(scale.identityKey ?? scale.sourceField);

	/**
	 * A label's opacity: the scale's own (travel, clipping) times its selection
	 * fade. Read by id where the tick's key is one — the only way to reach an
	 * Other bucket, whose label is not a value — and by value before identity.
	 */
	function opacityOf(tick: BandTick): number {
		const selected = !filterGroups
			? 1
			: scale.hasIdentity
				? filterGroups.opacityOfId(key, groups, tick.key)
				: filterGroups.opacityOfValue(key, groups, tick.value);
		return scale.tickOpacity(tick.key) * selected;
	}

	const tickEnd = $derived(base + dir * tickLength);
	const labelAt = $derived(base + dir * labelGap);
</script>

{#each ticks as tick (tick.key)}
	{@const pos = scale.tickPosition(tick.key, rangeSize, axis)}
	<g opacity={opacityOf(tick)}>
		{#if axis === 'x'}
			<line x1={pos} x2={pos} y1={base} y2={tickEnd} />
			<text text-anchor={textAnchor} x={pos} y={labelAt}>
				{categoryLabel(tick.value)}
			</text>
		{:else}
			<line x1={base} x2={tickEnd} y1={pos} y2={pos} />
			<text text-anchor={textAnchor} dominant-baseline="middle" x={labelAt} y={pos}>
				{categoryLabel(tick.value)}
			</text>
		{/if}
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
</style>
