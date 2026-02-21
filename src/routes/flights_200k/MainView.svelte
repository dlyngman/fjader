<script>
	import { Selection } from '@uwdata/mosaic-core';
	import { sum, min, max, avg, count } from '@uwdata/mosaic-sql';
	import { setContext, getContext } from 'svelte';
	import Plot from './Plot.svelte';

	import {
		ChartContainer,
		ColumnSelector,
		Grid,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		DotsMark,
		RectYMark,
		FilterBridge,
		IntervalX
	} from '$lib/components';
	import { bin } from '$lib/sql/bin';

	const coordinator = getContext('mosaic-coordinator');
	// const brushSeletion = Selection.crossfilter();
	const filterBridge = new FilterBridge(Selection, null);
</script>

<div class="main-view-container">
	<div class="chart-wrapper">
		<ChartContainer xLabel={'delay'} yLabel={'time'} xZoomLimit={10000} yZoomLimit={10000}>
			{#snippet background()}
				<!-- <Grid /> -->
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
							table="flights"
							selection={filterBridge.filterSel}
							x={min('delay')}
							y={'time'}
							fill={avg('delay')}
							opacity="0.8"
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet foreground()}
				<Crosshair />
			{/snippet}
		</ChartContainer>
	</div>
</div>

<div class="main-view-container">
	<div class="chart-wrapper" style="max-height: 300px;">
		<ChartContainer xLabel="distance">
			{#snippet background()}
				<!-- <Grid /> -->
				<Frame />
				<AxisLeft />
				<AxisBottom />
				<MarginLabel />
			{/snippet}

			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />

						<RectYMark
							table="flights"
							x={bin('distance', { steps: 50 })}
							y={count()}
							fill="red"
							viewportLocalDomain={true}
							selection={filterBridge.filterSel}
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet foreground()}
				<Crosshair />
			{/snippet}

			{#snippet interactors()}
				<IntervalX bridge={filterBridge} />
			{/snippet}
		</ChartContainer>
	</div>
</div>

<!-- <Plot selection={brushSeletion} /> -->

<style>
	.main-view-container {
		width: 100%;
		display: flex;
		flex-direction: column;
		/* align-items: center; */
		padding-bottom: 40px; /* Ensure space at bottom */
	}

	.charts-container {
		display: grid;
		grid-template-rows: repeat(var(--grid-rows), auto);
		grid-template-columns: repeat(var(--grid-columns), 1fr);
		gap: 10px;
		width: 80%;
		max-width: 1600px;
		margin: 20px auto;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 200px;
		/* max-height: 400px; */
		max-height: 600px;
		position: relative; /* Important for containing absolutely positioned children */
	}
</style>
