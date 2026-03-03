<script>
	import { Selection } from '@uwdata/mosaic-core';
	import { count } from '@uwdata/mosaic-sql';
	import {
		FilterBridge,
		IntervalX,
		Interval2D,
		ChartContainer,
		WebGPUCanvas,
		DotsMark,
		BarMarkY,
		Grid,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel
	} from '$lib/components';

	const filterBridge = new FilterBridge(Selection, null);
	globalThis.filterBridge = filterBridge;

	// // Reactive filter count
	// $effect(() => {
	// 	console.log('Active filters:', filterBridge.activeCount, $state.snapshot(filterBridge.items));
	// });
</script>

<div class="demo-container">
	<h1>Cross-Chart Brushing Demo</h1>

	<p class="instructions">
		<strong>Instructions:</strong> Drag in the scatter plot to create a 2D brush. The bar chart will
		update to show only filtered data. Click outside the brush to clear it, or drag to create a new
		one. Hold <kbd>Shift</kbd> and scroll to scale the brush.
	</p>

	<div class="charts-wrapper">
		<!-- Chart 1: Scatter plot with 2D brush -->
		<div class="chart-wrapper">
			<h2>Scatter Plot (with 2D Brush)</h2>
			<ChartContainer xLabel="bill_length" yLabel="bill_depth">
				{#snippet background()}
					<Frame />
					<AxisLeft />
					<AxisBottom />
					<MarginLabel />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<DotsMark
								table="penguins"
								x="bill_length"
								y="bill_depth"
								fill="species"
								opacity={0.6}
								selection={filterBridge.filterSel}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet interactors()}
					<Interval2D bridge={filterBridge} />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Chart 2: Bar chart (filtered by Chart 1, no brush) -->
		<div class="chart-wrapper">
			<h2>Bar Chart (Cross-Filtered)</h2>
			<ChartContainer xLabel="species" yLabel="count">
				{#snippet background()}
					<Frame />
					<AxisLeft />
					<!-- <AxisBottom /> -->
					<MarginLabel />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<BarMarkY
								table="penguins"
								x="species"
								y={count()}
								fill="species"
								selection={filterBridge.filterSel}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
			</ChartContainer>
		</div>
	</div>

	<!-- Filter status display -->
	<div class="filter-status">
		<h3>Active Filters: {filterBridge.activeCount}</h3>
		{#if filterBridge.items.length > 0}
			<div class="filter-chips">
				{#each filterBridge.items as item (item.source)}
					<div class="filter-chip">
						<span class="chip-label"
							>{item.schema?.label || 'Filter'}:
							{#if item.schema?.xValues && item.schema?.yValues}
								{item.schema.xColumn}: [{item.schema.xValues[0]?.toFixed(1)}, {item.schema.xValues[1]?.toFixed(
									1
								)}] × {item.schema.yColumn}: [{item.schema.yValues[0]?.toFixed(1)}, {item.schema.yValues[1]?.toFixed(
									1
								)}]
							{:else if item.schema?.values}
								[{item.schema.values[0]?.toFixed?.(1) ?? item.schema.values[0]}, {item.schema.values[1]?.toFixed?.(
									1
								) ?? item.schema.values[1]}]
							{:else}
								active
							{/if}
						</span>
						<button class="chip-clear" onclick={() => filterBridge.clear(item.source)}>×</button>
					</div>
				{/each}
			</div>
		{:else}
			<p class="no-filters">No active filters</p>
		{/if}
	</div>
</div>

<style>
	.demo-container {
		padding: 2rem;
		max-width: 1400px;
		margin: 0 auto;
	}

	h1 {
		margin-bottom: 1rem;
	}

	h2 {
		font-size: 1.1rem;
		margin-bottom: 0.5rem;
		color: var(--text-secondary, #666);
	}

	.instructions {
		background: var(--bg-info, #e3f2fd);
		padding: 1rem;
		border-radius: 4px;
		margin-bottom: 2rem;
		line-height: 1.6;
	}

	.charts-wrapper {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2rem;
		margin-bottom: 2rem;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 300px;
		position: relative;
	}

	.filter-status {
		background: var(--bg-secondary, #f5f5f5);
		padding: 1.5rem;
		border-radius: 8px;
		border: 1px solid var(--border, #ddd);
	}

	.filter-status h3 {
		margin-top: 0;
		margin-bottom: 1rem;
		font-size: 1.1rem;
	}

	.filter-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.filter-chip {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: white;
		padding: 0.5rem 0.75rem;
		border-radius: 20px;
		border: 1px solid var(--brush-stroke, rgba(100, 150, 255, 0.7));
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}

	.chip-label {
		font-size: 0.9rem;
		color: var(--text, #333);
	}

	.chip-clear {
		background: none;
		border: none;
		color: var(--text-muted, #999);
		font-size: 1.2rem;
		cursor: pointer;
		padding: 0;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		transition: all 0.2s;
	}

	.chip-clear:hover {
		background: var(--bg-hover, #f0f0f0);
		color: var(--text, #333);
	}

	.no-filters {
		color: var(--text-muted, #999);
		font-style: italic;
		margin: 0;
	}

	@media (max-width: 768px) {
		.charts-wrapper {
			grid-template-columns: 1fr;
		}
	}
</style>
