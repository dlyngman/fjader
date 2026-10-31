<script>
	import {
		ChartContainer,
		Grid,
		Crosshair,
		WebGPUCanvas,
		LineMark,
		IntervalX
	} from '$lib/components';
</script>

<div class="main-view-container">
	<h2>Overview + Detail (Brush-Linked Domain)</h2>
	<p>
		Drag a brush on the overview to zoom the detail chart. Pan/zoom the detail and the brush tracks.
	</p>

	<div class="charts-stack">
		<!-- Detail chart: domain follows overview brush -->
		<div class="detail-wrapper">
			<ChartContainer xLabel="x" yLabel="y" useXSelection>
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark table="timeseries" x="x" y="y" strokeWidth={1.5} fitDomain="y" />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Overview chart: full range, brushable -->
		<div class="overview-wrapper">
			<ChartContainer xLabel="x" yLabel="y" margin={{ top: 10, right: 50, bottom: 25, left: 75 }}>
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<LineMark table="timeseries" x="x" y="y" strokeWidth={1} />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet interactors()}
					<IntervalX />
				{/snippet}
			</ChartContainer>
		</div>
	</div>
</div>

<style>
	.main-view-container {
		width: 100%;
		max-width: 1000px;
		margin: 0 auto;
		padding: 20px;
	}

	h2 {
		margin-bottom: 4px;
	}

	p {
		margin-bottom: 16px;
		color: #666;
		font-size: 14px;
	}

	.charts-stack {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.detail-wrapper {
		width: 100%;
		height: 400px;
	}

	.overview-wrapper {
		width: 100%;
		height: 120px;
	}
</style>
