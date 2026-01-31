<script>
	import { Selection } from '@uwdata/mosaic-core';
	import { sum, min, max, avg, count } from '@uwdata/mosaic-sql';
	import { setContext, getContext } from 'svelte';
	// import Plot from './Plot.svelte';

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
		RectYMark
	} from '$lib/components';
	import LineMark from '$lib/components/marks/LineMark.svelte';
	import { bin } from '$lib/sql/bin.js';

	const coordinator = getContext('mosaic-coordinator');
	const brushSeletion = Selection.crossfilter();
</script>

<div class="main-view-container">
	<div class="chart-wrapper">
		<ChartContainer>
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
							x={bin('delay', { step: 2 })}
							y={count()}
							color="steelblue"
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
		max-height: 800px;
		position: relative; /* Important for containing absolutely positioned children */
	}
</style>
