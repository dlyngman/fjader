<script>
	import { clausePoints } from '@uwdata/mosaic-core';
	import { column } from '@uwdata/mosaic-sql';

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
	} = $props();

	// Reactive: re-renders when domain or scheme changes
	const items = $derived(
		scaleState.domain.map((value) => ({
			value,
			color: scaleState.getColor(value)
		}))
	);

	// --- Toggle interaction ---
	const isInteractive = $derived(bridge != null && field != null);
	const source = `legend-toggle-${field}`;
	const columnRef = field ? column(field) : null;

	// Register with FilterBridge when interactive
	const toggle = bridge && field
		? bridge.createLocal('single', {
				source,
				augment: (clause) => ({
					kind: 'toggle',
					column: field,
					label: field,
					values: clause?.value?.map((v) => v[0]) ?? []
				})
			})
		: null;

	const selection = toggle?.sel;

	// Derive visual state from bridge.items (bidirectional)
	const selectedSet = $derived.by(() => {
		if (!bridge || !field) return null;
		for (const item of bridge.items) {
			if (item.schema?.column === field && item.clause?.meta?.type === 'point') {
				const vals = item.clause?.value;
				if (vals?.length) return new Set(vals.map((v) => v[0]));
			}
		}
		return null;
	});

	function handleClick(value, event) {
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

		selection.update(clausePoints([columnRef], newValues, { source }));
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
		{#each items as { value, color }}
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
		font-family: system-ui, sans-serif;
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
		color: var(--text-secondary, #555);
	}
</style>
