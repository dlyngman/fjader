<script>
	import { count } from '@uwdata/mosaic-sql';
	import {
		ChartContainer,
		Grid,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		LineMark
	} from '$lib/components';
	import { bin } from '$lib/sql/bin';
	import RectYMark from '$lib/components/marks/RectYMark.svelte';
</script>

<div class="main-view-container">
	<h2>LineMark + bin() Test</h2>
	<p>Testing stroke prop: constant color, series grouping, and stroke-only (no explicit color).</p>

	<div class="charts-grid">
		<div class="chart-section">
			<h3>stroke="steelblue" (constant color)</h3>
			<div class="chart-wrapper">
				<ChartContainer xLabel="timestamp" yLabel="count (const)">
					<MarginLabel />
					<AxisLeft />
					<AxisBottom />

					<Grid />
					<LineMark
						table="events"
						x={bin('timestamp', { interval: 'day' })}
						y={count()}
						stroke="steelblue"
					/>

					<Crosshair />
				</ChartContainer>
			</div>
		</div>

		<div class="chart-section">
			<h3>stroke="category" (series + auto color)</h3>
			<div class="chart-wrapper">
				<ChartContainer xLabel="timestamp" yLabel="count (series)">
					<MarginLabel />
					<AxisLeft />
					<AxisBottom />

					<Grid />
					<LineMark
						table="events"
						x={bin('timestamp', { interval: 'day' })}
						y={count()}
						stroke="category"
					/>

					<Crosshair />
				</ChartContainer>
			</div>
		</div>

		<div class="chart-section">
			<h3>z="category" stroke="tomato" (constant color, grouped by category)</h3>
			<div class="chart-wrapper">
				<ChartContainer xLabel="timestamp" yLabel="count (override)">
					<MarginLabel />
					<AxisLeft />
					<AxisBottom />

					<Grid />
					<LineMark
						table="events"
						x={bin('timestamp', { interval: 'day' })}
						y={count()}
						z="category"
						stroke="tomato"
					/>

					<Crosshair />
				</ChartContainer>
			</div>
		</div>
		<div class="chart-section">
			<h3>bin('timestamp', &#123;steps: 50&#125;) — shift+scroll</h3>
			<div class="chart-wrapper">
				<ChartContainer xLabel="timestamp" yLabel="count (steps)">
					<MarginLabel />
					<AxisLeft />
					<AxisBottom />

					<Grid />
					<RectYMark
						table="events"
						x={bin('timestamp', { steps: 50 })}
						y={count()}
						fill="category"
					/>
					<LineMark
						table="events"
						x={bin('timestamp', { steps: 50 })}
						y={count()}
						stroke="category"
					/>

					<Crosshair />
				</ChartContainer>
			</div>
		</div>
	</div>
</div>

<style>
	.main-view-container {
		width: 100%;
		max-width: 900px;
		margin: 0 auto;
		padding: 20px;
	}

	h2 {
		margin-bottom: 4px;
	}

	p {
		margin-bottom: 20px;
		color: #666;
	}

	.charts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
		gap: 24px;
	}

	.chart-section h3 {
		font-size: 13px;
		font-weight: 600;
		margin-bottom: 8px;
		color: #333;
		font-family: monospace;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 250px;
		max-height: 400px;
		border: 1px solid #ddd;
		border-radius: 8px;
		overflow: hidden;
	}
</style>
