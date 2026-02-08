<script>
	let {
		scaleState,
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
</script>

<div class="legend-ordinal {className}" style:--columns={columns}>
	{#if title}
		<span class="legend-title">{title}</span>
	{/if}
	<div class="legend-swatches" class:legend-columns={columns} class:legend-vertical={orientation === 'vertical'}>
		{#each items as { value, color }}
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
		{/each}
	</div>
</div>

<style>
	.legend-ordinal {
		font-family: system-ui, sans-serif;
		font-size: 10px;
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

	.legend-swatch {
		display: inline-block;
		flex-shrink: 0;
	}

	.legend-label {
		color: var(--text-secondary, #555);
	}
</style>
