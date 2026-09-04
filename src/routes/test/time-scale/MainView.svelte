<script>
	import {
		ChartContainer,
		WebGPUCanvas,
		Grid,
		DotsMark,
		Crosshair,
		AxisLeft,
		AxisBottom,
		MarginLabel
	} from '$lib/components';
</script>

<div class="main-view-container">
	<h2>Time Scale Test</h2>

	<div class="chart-wrapper">
		<ChartContainer xLabel="timestamp" yLabel="value">
			{#snippet background()}
				<AxisLeft />
				<AxisBottom />
			{/snippet}
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<DotsMark
							table="timeseries"
							x="timestamp"
							y="value"
							fill="sensor"
							opacity={0.6}
							r={5}
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet foreground()}
				<Crosshair />
				<MarginLabel />
			{/snippet}
		</ChartContainer>
	</div>
</div>

<style>
	.main-view-container {
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 20px;
	}

	h2 {
		color: var(--text-primary, #fff);
		margin-bottom: 20px;
	}

	.chart-wrapper {
		width: 80%;
		max-width: 1200px;
		aspect-ratio: 16/9;
		min-height: 300px;
		max-height: 500px;
	}
</style>
