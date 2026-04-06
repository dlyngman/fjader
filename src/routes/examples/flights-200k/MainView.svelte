<script>
	import { min, avg, count } from '@uwdata/mosaic-sql';

	import {
		ChartContainer,
		Grid,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		DotsMark,
		RectYMark,
		IntervalX
	} from '$lib/components';
	import { bin } from '$lib/sql/bin';
</script>

<div class="main-view-container">
	<div class="chart-wrapper">
		<ChartContainer xLabel="delay" yLabel="time" xZoomLimit={10000} yZoomLimit={10000}>
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
							selection="brush"
							x={min('delay')}
							y="time"
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
							fitDomain
							selection="brush"
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet foreground()}
				<Crosshair />
			{/snippet}

			{#snippet interactors()}
				<IntervalX selection="brush" />
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
