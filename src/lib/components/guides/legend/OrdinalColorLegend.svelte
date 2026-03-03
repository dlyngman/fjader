<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import { clausePoints } from '@uwdata/mosaic-core';
	import { column } from '@uwdata/mosaic-sql';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
	import type { FilterBridge } from '$lib/selection/filter-bridge.svelte';

	interface Props {
		scaleState: ColorScaleState;
		bridge?: FilterBridge | null;
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
		bridge = null,
		field = null,
		title,
		columns = null,
		swatchSize = 15,
		swatchRadius = 0,
		className = '',
		orientation = 'horizontal'
	}: Props = $props();

	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Reactive: re-renders when domain or scheme changes
	const items = $derived(
		scaleState.domain.map((value) => ({
			value,
			color: scaleState.getColor(value)
		}))
	);

	// --- Toggle interaction ---
	const isInteractive = $derived(bridge != null && field != null);
	const columnRef = field ? column(field) : null;

	// Getter for scale states — includes color scale + any band scale for same field
	function getLegendScaleStates() {
		const band = scaleRegistry?.getScaleByField(field, 'band');
		return [scaleState, band].filter(Boolean);
	}

	// Shared toggle Selection — deduplicated by column across Toggle + Legend
	const toggle =
		bridge && field
			? bridge.createToggle(field, { scaleStates: getLegendScaleStates as () => any[] })
			: null;

	const selection = toggle?.sel;
	const source = toggle?.source;

	onDestroy(() => toggle?.off());

	// Derive visual state from scale's activeValues (projected by FilterBridge)
	const selectedSet = $derived(scaleState.activeValues);

	function handleClick(value: string | number, event: MouseEvent) {
		if (!selection || !columnRef) return;

		const isMulti = event.shiftKey || event.metaKey;
		let newValues;

		if (isMulti && selectedSet) {
			// Shift/Cmd+click: toggle this item in the set
			const next = new Set(selectedSet);
			if (next.has(value)) {
				next.delete(value);
			} else {
				next.add(value);
			}
			// All selected or none selected → clear filter
			if (next.size === 0 || next.size === scaleState.domain.length) {
				newValues = null;
			} else {
				newValues = Array.from(next).map((v) => [v]);
			}
		} else if (selectedSet?.size === 1 && selectedSet.has(value)) {
			// Click on the only selected item → deselect all
			newValues = null;
		} else {
			// Normal click → select only this item
			newValues = [[value]];
		}

		if (newValues === null) {
			bridge.clearToggle(field);
		} else {
			selection.update(
				clausePoints([columnRef], newValues, {
					source: source as unknown as import('@uwdata/mosaic-core').ClauseSource
				})
			);
		}
	}
</script>

<div
	class="legend-ordinal {className}"
	class:legend-interactive={isInteractive}
	style:--columns={columns}
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
