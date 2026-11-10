<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import type { ChartContext } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { DimValue } from '$lib/query-engine/categorical-identity';
	import { categoryLabel } from '$lib/query-engine/categorical-identity';

	interface Props {
		scaleState: ColorScaleState;
		selection?: string;
		field?: string | null;
		title?: string | null;
		columns?: number | null;
		swatchSize?: number;
		swatchRadius?: number;
		className?: string;
		orientation?: 'horizontal' | 'vertical';
	}

	let {
		scaleState,
		selection = undefined,
		field = null,
		title,
		columns = null,
		swatchSize = 15,
		swatchRadius = 0,
		className = '',
		orientation = 'horizontal'
	}: Props = $props();

	const filterGroups = getContext<FilterGroupRegistry | undefined>('filter-groups');
	const filterGroup = filterGroups?.get(selection);

	const chartContext = getContext<ChartContext | undefined>('chart');

	/**
	 * The chart's band axis on this legend's field, if it has one. The legend then
	 * lists what that axis shows (a top N and its Other, a table's own categories)
	 * rather than every category of the field, which is what the colour scale's
	 * domain holds: it is shared per field across charts.
	 */
	const bandOnField = $derived.by(() => {
		// Neither identityKey is reactive state, and both are null until identity
		// lands, which is after this first runs: read the signals that change
		// with them, or this stays null for good.
		void scaleState.ranksRevision;
		const key = scaleState.identityKey;
		if (!chartContext || !key) return null;
		for (const axis of ['x', 'y'] as const) {
			const type = chartContext.scaleTypes?.[axis];
			if (type !== 'band' && type !== 'point') continue;
			const band = chartContext[`${axis}ScaleState`] as BandScaleState | null;
			if (!band) continue;
			void band._version;
			if (band.identityKey === key) return band;
		}
		return null;
	});

	interface Item {
		/** The category's dim id, when the legend follows a band axis. */
		id: number | null;
		value: DimValue;
		color: string;
		/** An Other bucket: shown, not clickable (it names no value). */
		bucket: boolean;
	}

	// Reactive: re-renders when the domain, the axis or the palette ranks change.
	const items = $derived.by((): Item[] => {
		const band = bandOnField;
		if (band) {
			void band._version;
			const ids = band.displayOrder;
			const values = band.effectiveDomain;
			const identity = scaleState.identity;
			return Array.from(ids, (id, i) => ({
				id,
				value: values[i],
				color: scaleState.getColor(values[i] as string | number | null),
				bucket: identity?.synthetic.has(id) ?? false
			}));
		}
		return scaleState.domain.map((value) => ({
			id: null,
			value,
			color: scaleState.getColor(value),
			bucket: false
		}));
	});

	// --- Toggle interaction ---
	const isInteractive = $derived(filterGroup != null && field != null);

	/**
	 * The field's identity key: what its selection is kept under. The scale's
	 * own once it has identity; the field before, as the toggle keys it. For a
	 * plain column the two are the same. For a computed field (an expression)
	 * they differ, so while a reload empties the identity the legend reads the
	 * selection under the field's name and its highlight is briefly lost.
	 */
	const key = $derived(scaleState.identityKey ?? field ?? scaleState.field);
	const groups = $derived(filterGroup ? [filterGroup.index] : []);

	/**
	 * How visible an entry is now: its group's selection fade on the field, on
	 * the same clock and with the same floor as the marks.
	 */
	function opacityOf(item: Item): number {
		if (!filterGroups) return 1;
		// By id where there is one: the only way to reach an Other bucket.
		return item.id !== null
			? filterGroups.opacityOfId(key, groups, item.id)
			: filterGroups.opacityOfValue(key, groups, item.value);
	}

	// The selection is shared with any Toggle on the same field through its clause.
	// A legend inside a chart skips that chart, as a Toggle there does: its marks
	// keyed by the field dim, the rest keep their data. A standalone legend is in
	// no chart, so every chart in its group is routed by its marks alone.
	const toggle =
		filterGroup && field
			? filterGroup.registerToggle(field, { chart: chartContext?.config ?? null })
			: null;
	onDestroy(() => toggle?.destroy());

	// Shift/meta-click adds or removes; selecting every value clears instead.
	function handleClick(value: DimValue, event: MouseEvent) {
		toggle?.toggle([value], event.shiftKey || event.metaKey, scaleState.domain.length);
	}
</script>

<div
	class="legend-ordinal {className}"
	class:legend-interactive={isInteractive}
	style:--columns={columns}
	onpointerenter={() => toggle?.activate()}
>
	{#if title}
		<span class="legend-title">{title}</span>
	{/if}
	<div
		class="legend-swatches"
		class:legend-columns={columns}
		class:legend-vertical={orientation === 'vertical'}
	>
		{#each items as item (item.id ?? item.value)}
			{@const { value, color } = item}
			{#if isInteractive && !item.bucket}
				<button
					class="legend-item legend-item-interactive"
					style:opacity={opacityOf(item)}
					onclick={(e) => handleClick(value, e)}
				>
					<span
						class="legend-swatch"
						style:background={color}
						style:width="{swatchSize}px"
						style:height="{swatchSize}px"
						style:border-radius="{swatchRadius}px"
					></span>
					<span class="legend-label">{categoryLabel(value)}</span>
				</button>
			{:else}
				<span class="legend-item" style:opacity={opacityOf(item)}>
					<span
						class="legend-swatch"
						style:background={color}
						style:width="{swatchSize}px"
						style:height="{swatchSize}px"
						style:border-radius="{swatchRadius}px"
					></span>
					<span class="legend-label">{categoryLabel(value)}</span>
				</span>
			{/if}
		{/each}
	</div>
</div>

<style>
	.legend-ordinal {
		font-family: var(--fjader-font, system-ui, sans-serif);
		font-size: 10px;
	}

	.legend-interactive {
		pointer-events: auto;
	}

	.legend-title {
		font-weight: 700;
		display: block;
		margin-bottom: 4px;
	}

	.legend-swatches {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		align-items: center;
	}

	.legend-columns {
		display: grid;
		grid-template-columns: repeat(var(--columns, 1), auto);
	}

	.legend-vertical {
		flex-direction: column;
		flex-wrap: nowrap;
		align-items: flex-start;
		gap: 4px;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;
	}

	.legend-item-interactive {
		cursor: pointer;
		user-select: none;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: inherit;
	}

	.legend-swatch {
		display: inline-block;
		flex-shrink: 0;
	}

	.legend-label {
		color: var(--fjader-text-secondary, #6b7280);
	}
</style>
