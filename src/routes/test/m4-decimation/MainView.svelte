<script>
	import { getContext } from 'svelte';
	import { ChartContainer, Grid, Crosshair, WebGPUCanvas, LineMark } from '$lib/components';

	const coordinator = getContext('mosaic-coordinator');
</script>

<div class="main-view-container">
	<h2>M4 Decimation Test</h2>
	<p>100K points (33K per series). M4 should auto-activate and decimate to ~4 points/pixel.</p>

	<div class="charts-grid">
		<div class="chart-wrapper">
			<h3>M4 Enabled (optimize=true)</h3>
			<ChartContainer xLabel="x" yLabel="y" xZoomLimit={10000} yZoomLimit={10000}>
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="dense_timeseries"
								x="x"
								y="y"
								stroke="series"
								curve="monotone"
								strokeWidth={1.5}
								optimize={true}
								dotRadius={0}
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
			<h3>M4 Disabled (optimize=false) - Reference</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="dense_timeseries"
								x="x"
								y="y"
								stroke="series"
								strokeWidth={1.5}
								optimize={false}
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
			<h3>M4 Auto (default)</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="dense_timeseries"
								x="x"
								y="y"
								stroke="series"
								strokeWidth={1.5}
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
