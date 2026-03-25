<script>
	import { ChartContainer, Grid, Crosshair, WebGPUCanvas, LineMark } from '$lib/components';

	let smoothWindow = $state(0);
	let pollInterval = null;
</script>

<div class="container">
	<h2>LOD Smoothing Overlay Test</h2>
	<p>
		Zoomed out: shift+scroll to add rolling average smoothing (one lag at a time). Zoomed in:
		shift+scroll to control dots threshold.
	</p>
	<p class="hint">
		Current smooth window: <strong>{smoothWindow}</strong>
		{#if smoothWindow > 0}
			({2 * smoothWindow + 1}-point rolling average)
		{:else}
			(off)
		{/if}
	</p>

	<div class="chart-wrapper">
		<ChartContainer xLabel="time" yLabel="value" xZoomLimit={10000} yZoomLimit={10000}>
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<LineMark
							table="noisy_timeseries"
							x="time"
							y="value"
							stroke="series"
							strokeWidth={1.5}
							lod
							onMarkLOD={(surface) => {
								clearInterval(pollInterval);
								pollInterval = null;
								if (surface) {
									pollInterval = setInterval(() => {
										const rungs = surface.getRungs();
										const smooth = rungs.find((r) => r.name === 'smooth');
										smoothWindow = smooth ? (smooth.props.window ?? 0) : 0;
									}, 100);
								}
							}}
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet foreground()}
				<Crosshair />
			{/snippet}
		</ChartContainer>
	</div>

	<h3>Single series (no stroke grouping)</h3>
	<div class="chart-wrapper">
		<ChartContainer xLabel="time" yLabel="value" xZoomLimit={10000} yZoomLimit={10000}>
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<LineMark table="noisy_timeseries" x="time" y="value" strokeWidth={1} lod />
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet foreground()}
				<Crosshair />
			{/snippet}
		</ChartContainer>
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

	h2,
	h3 {
		margin: 0;
	}

	p {
		margin: 0;
		color: #666;
	}

	.hint {
		font-family: monospace;
		font-size: 13px;
	}

	.chart-wrapper {
		width: 100%;
		height: 45vh;
		min-height: 250px;
	}
</style>
