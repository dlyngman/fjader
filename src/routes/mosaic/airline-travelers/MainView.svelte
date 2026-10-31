<script>
	import { sum, min, max, avg } from '@uwdata/mosaic-sql';
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
	import { bin } from '$lib';
	import LineMark from '$lib/components/marks/LineMark.svelte';
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

						<!-- <LineMark table="travelers" x="date" y="previous" stroke="red" /> -->
						<LineMark
							table="travelers"
							x={bin('date')}
							y={max('previous')}
							curve="monotone"
							stroke="red"
							dotRadius={5}
						/>
						<LineMark
							table="travelers"
							x={bin('date')}
							y={min('previous')}
							curve="monotone"
							stroke="red"
							dotRadius={5}
						/>
						<LineMark
							table="travelers"
							x="date"
							y="previous"
							curve="monotone"
							stroke="green"
							dotRadius={4}
						/>

						<!-- <DotsMark table="travelers" x="date" y="previous" opacity="1" fill="red" /> -->
						<LineMark table="travelers" x="date" y="current" stroke="blue" />
						<DotsMark table="travelers" x="date" y="current" opacity="1" fill="blue" />
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
