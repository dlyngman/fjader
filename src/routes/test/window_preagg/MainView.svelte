<script>
	import {
		ChartContainer,
		WebGPUCanvas,
		DotsMark,
		LineMark,
		Grid,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		Interval1D
	} from '$lib/components';
	import { avg } from '@uwdata/mosaic-sql';
</script>

<div class="container">
	<h2>Window Preagg CTE — Realistic Workload</h2>
	<p class="instructions">
		<strong>Setup:</strong> 1M web request events over 30 days × 5 regions. Each (date, region, payload_bin)
		cell holds ~26 events, so the preagg table collapses ~26×.
		<br /><br />
		<strong>Test steps:</strong>
		1. Shift+scroll on the line chart to activate rolling average smoothing.
		2. Drag the brush horizontally on the scatter plot to filter by payload size.
		3. Compare console: <code>[preagg]</code> times should be much faster than <code>[base]</code> times.
	</p>

	<div class="charts-wrapper">
		<div class="chart-wrapper">
			<ChartContainer xLabel="date" yLabel="avg response time (ms)">
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
							<LineMark
								table="web_events"
								x="date"
								y={avg('response_time')}
								stroke="region"
								strokeWidth={1.5}
								selection="brush"
								lod
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<div class="chart-wrapper">
			<ChartContainer xLabel="payload size (bytes)" yLabel="response time (ms)">
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
								table="web_events"
								x="payload_size"
								y="response_time"
								fill="region"
								opacity={0.05}
								selection="brush"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}

				{#snippet interactors()}
					<Interval1D selection="brush" axis="x" />
				{/snippet}
			</ChartContainer>
		</div>
	</div>
</div>

<style>
	.container {
		width: 100%;
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	h2 {
		margin: 0;
	}

	.instructions {
		margin: 0;
		padding: 1rem;
		background: #e3f2fd;
		border-radius: 4px;
		line-height: 1.6;
	}

	.instructions code {
		background: rgba(0, 0, 0, 0.08);
		padding: 0.15em 0.4em;
		border-radius: 3px;
		font-size: 0.9em;
	}

	.charts-wrapper {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2rem;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 300px;
	}
</style>
