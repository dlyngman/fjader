<script>
	import { eq, literal } from '@uwdata/mosaic-sql';
	import {
		ChartContainer,
		Grid,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		LineMark
	} from '$lib/components';
	import { filter } from '$lib/transforms';
</script>

<div class="main-view-container">
	<h2>Line Chart Test</h2>
	<p>Testing: Series boundaries, gaps (null values), miter joins, screen-space stroke width</p>

	<div class="charts-grid">
		<!-- Multi-series line chart with color by series -->
		<div class="chart-wrapper">
			<h3>Multi-Series (color by series)</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="timeseries"
								x="x"
								y="y"
								stroke="series"
								strokeWidth={2}
								tooltipProximity="x"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Same data with thicker lines and constant color -->
		<div class="chart-wrapper">
			<h3>Thick Lines (strokeWidth=5, constant color, z=series)</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="timeseries"
								x="x"
								y="y"
								z="series"
								stroke="#2196f3"
								strokeWidth={5}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Single series (Series A only, filtered with SQL WHERE) -->
		<div class="chart-wrapper">
			<h3>Single Series (SQL filter: series = 'Series A')</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="timeseries"
								x="x"
								y="y"
								transforms={[filter(eq('series', literal('Series A')))]}
								strokeWidth={3}
								stroke="#e63946"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<!-- <AxisLeft /> -->
					<!-- <AxisBottom /> -->
					<!-- <MarginLabel /> -->
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>
	</div>
</div>

<style>
	.main-view-container {
		width: 100%;
		padding: 20px;
	}

	h2 {
		margin-bottom: 10px;
	}

	p {
		margin-bottom: 20px;
		color: #666;
	}

	.charts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
		gap: 20px;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 300px;
		max-height: 500px;
	}

	h3 {
		margin-bottom: 10px;
		font-size: 14px;
		color: #333;
	}
</style>
