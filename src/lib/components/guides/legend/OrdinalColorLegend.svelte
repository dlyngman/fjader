<script lang="ts">
	import { getContext } from 'svelte';
	import { column, isIn, literal } from '@uwdata/mosaic-sql';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
	import type { ToggleState } from '$lib/query-engine/FilterGroup.svelte';
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
		field = null,
		title,
		columns = null,
		swatchSize = 15,
		swatchRadius = 0,
		className = '',
		orientation = 'horizontal'
	}: Props = $props();

	const filterGroups = getContext<FilterGroupRegistry | undefined>('filter-groups');
	const filterGroup = filterGroups?.get();
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Reactive: re-renders when domain or scheme changes
	const items = $derived(
		scaleState.domain.map((value) => ({
			value,
			color: scaleState.getColor(value)
		}))
	);

	// --- Toggle interaction ---
	const columnRef = field ? column(field) : null;
	const isInteractive = $derived(filterGroup != null && field != null);

	// Getter for scale states — includes color scale + any band scale for same field
	function getLegendScaleStates() {
		const band = scaleRegistry?.getScaleByField(field, 'band');
		return [scaleState, band].filter(Boolean) as {
			setActiveValues(values: Set<unknown>): void;
			clearActiveValues(): void;
		}[];
	}

	// Shared toggle state — deduplicated by field across Toggle + Legend
	const toggleState: ToggleState | null =
		filterGroup && field ? filterGroup.getOrCreateToggle(field) : null;

	// Derive visual state from toggle state
	const selectedSet = $derived(
		toggleState?.active ? toggleState.values : null
	);

	// Sync toggle values to FilterGroup + scale projection
	function syncFilter() {
		if (!toggleState || !filterGroup || !field) return;
		const values = toggleState.values;
		const scales = getLegendScaleStates();

		if (values.size === 0) {
			filterGroup.syncToggle(field, null, null, () =>
				chart ? new Set(chart.config.entries.keys()) : new Set()
			);
			for (const s of scales) s.clearActiveValues();
			return;
		}

		const predicate = isIn(columnRef!, Array.from(values).map((v) => literal(v)));
		filterGroup.syncToggle(field, predicate, [...values], () => new Set<string>()
		);
		for (const s of scales) s.setActiveValues(values);
	}

	function handleClick(value: string | number, event: MouseEvent) {
		if (!toggleState) return;

		const isMulti = event.shiftKey || event.metaKey;

		if (isMulti) {
			toggleState.toggle(value, true);
			// If all selected or none selected → clear
			if (toggleState.values.size === scaleState.domain.length) {
				toggleState.clear();
			}
		} else if (toggleState.values.size === 1 && toggleState.values.has(value)) {
			toggleState.clear();
		} else {
			toggleState.select(value);
		}
		syncFilter();
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
