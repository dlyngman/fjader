<script>
	import { count } from '@uwdata/mosaic-sql';

	import {
		ChartContainer,
		Grid,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		RectYMark,
		IntervalX
	} from '$lib/components';
	import { bin } from '$lib/sql/bin';

	let fitY = $state(true);
</script>

<div class="main-view-container">
	<label>
		<input type="checkbox" bind:checked={fitY} />
		fitDomain
	</label>
	<div class="chart-wrapper">
		<ChartContainer xLabel="delay" yLabel="Count">
			<!-- <Grid /> -->
			<Frame />
			<AxisLeft />
			<AxisBottom />
			<MarginLabel />

			<Grid />

			<RectYMark
				table="flights"
				x={bin('delay', { steps: 50 })}
				y={count()}
				inset={0.5}
				fill="steelblue"
				fitDomain={fitY}
				selection="brush"
			/>

			<Crosshair />

			<IntervalX selection="brush" />
		</ChartContainer>
	</div>
	<div class="chart-wrapper">
		<ChartContainer xLabel="time" yLabel="Count per time">
			<!-- <Grid /> -->
			<Frame />
			<AxisLeft />
			<AxisBottom />
			<MarginLabel />

			<Grid />

			<RectYMark
				table="flights"
				x={bin('time', { steps: 50 })}
				y={count()}
				inset={0.5}
				fill="steelblue"
				fitDomain={fitY}
				selection="brush"
			/>

			<Crosshair />

			<IntervalX selection="brush" />
		</ChartContainer>
	</div>
	<div class="chart-wrapper">
		<ChartContainer xLabel="distance" yLabel="Count per distance">
			<!-- <Grid /> -->
			<Frame />
			<AxisLeft />
			<AxisBottom />
			<MarginLabel />

			<Grid />

			<RectYMark
				table="flights"
				x={bin('distance', { steps: 50 })}
				y={count()}
				inset={0.5}
				fill="steelblue"
				fitDomain={fitY}
				selection="brush"
			/>

			<Crosshair />

			<IntervalX selection="brush" />
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
		min-height: 100px;
		/* max-height: 400px; */
		max-height: 300px;
		position: relative; /* Important for containing absolutely positioned children */
	}
</style>
