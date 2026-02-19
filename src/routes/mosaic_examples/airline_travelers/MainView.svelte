<script>
	import { Selection } from '@uwdata/mosaic-core';
	import { sum, min, max, avg } from '@uwdata/mosaic-sql';
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
		DotsMark
	} from '$lib/components';
	import LineMark from '$lib/components/marks/LineMark.svelte';

	const coordinator = getContext('mosaic-coordinator');
	const brushSeletion = Selection.crossfilter();
</script>

<div class="main-view-container">
	<div class="chart-wrapper">
		<ChartContainer xZoomLimit={10000} yZoomLimit={10000}>
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

						<!-- <LineMark table="travelers" x="date" y="previous" alpha="0.8" color="red" /> -->
						<LineMark table="travelers" x="date" y="previous" curve="monotone" alpha="0.8" color="red" dotRadius={4}/>

						<!-- <DotsMark table="travelers" x="date" y="previous" alpha="1" color="red" /> -->
						<LineMark table="travelers" x="date" y="current" alpha="0.8" color="blue" />
						<DotsMark table="travelers" x="date" y="current" alpha="1" color="blue" />
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
