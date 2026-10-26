<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
	import type { ActiveValueScale } from '$lib/query-engine/FilterGroup.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

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
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Reactive: re-renders when domain or scheme changes
	const items = $derived(
		scaleState.domain.map((value) => ({
			value,
			color: scaleState.getColor(value)
		}))
	);

	// --- Toggle interaction ---
	const isInteractive = $derived(filterGroup != null && field != null);

	// Scales to dim: this color scale + any band scale for the same field.
	// Projection itself is handled by FilterGroup, shared with Toggle/brushes.
	function getLegendScaleStates(): ActiveValueScale[] {
		const band = scaleRegistry?.getScaleByField(field!, 'band');
		return [scaleState, band].filter(Boolean) as unknown as ActiveValueScale[];
	}

	// The selection is shared with any Toggle on the same field through its clause.
	// A legend is not a chart, so it excludes no marks: every chart filters.
	const toggle =
		filterGroup && field
			? filterGroup.registerToggle(field, {
					excludeMarkIds: () => new Set<string>(),
					scales: getLegendScaleStates
				})
			: null;
	onDestroy(() => toggle?.destroy());

	// Derive visual state from the toggle's selection
	const selectedSet = $derived(toggle?.active ? toggle.values : null);

	// Shift/meta-click adds or removes; selecting every value clears instead.
	function handleClick(value: string | number, event: MouseEvent) {
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
		{#each items as { value, color } (value)}
			{#if isInteractive}
				<button
					class="legend-item legend-item-interactive"
					class:legend-item-dimmed={selectedSet != null && !selectedSet.has(value)}
					onclick={(e) => handleClick(value, e)}
				>
					<span
						class="legend-swatch"
						style:background={color}
						style:width="{swatchSize}px"
						style:height="{swatchSize}px"
						style:border-radius="{swatchRadius}px"
					></span>
					<span class="legend-label">{value}</span>
				</button>
			{:else}
				<span class="legend-item">
					<span
						class="legend-swatch"
						style:background={color}
						style:width="{swatchSize}px"
						style:height="{swatchSize}px"
						style:border-radius="{swatchRadius}px"
					></span>
					<span class="legend-label">{value}</span>
				</span>
			{/if}
		{/each}
	</div>
</div>

<style>
	.legend-ordinal {
		font-family: var(--diveplot-font, system-ui, sans-serif);
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
		transition: opacity 0.15s ease;
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

	.legend-item-dimmed {
		opacity: 0.2;
	}

	.legend-swatch {
		display: inline-block;
		flex-shrink: 0;
	}

	.legend-label {
		color: var(--diveplot-text-secondary, #6b7280);
	}
</style>
