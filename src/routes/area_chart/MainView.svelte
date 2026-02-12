<script>
	import { getContext } from 'svelte';
	import { eq, literal } from '@uwdata/mosaic-sql';
	import {
		ChartContainer,
		Grid,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		LineMark,
		AreaMarkY
	} from '$lib/components';
	import { filter, stack } from '$lib/transforms';

	const coordinator = getContext('mosaic-coordinator');
</script>

<div class="main-view-container">
	<h2>Area Chart Test</h2>
	<p>Testing: AreaMarkY with single series, multi-series, stacked areas, and line+area overlay</p>

	<div class="charts-grid">
		<!-- Simple single-series area -->
		<div class="chart-wrapper">
			<h3>Single Series Area</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<AreaMarkY
								table="area_data"
								x="x"
								y="y"
								transforms={[filter(eq('series', literal('Alpha')))]}
								fillOpacity={0.4}
								color="#4e79a7"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Multi-series areas (overlapping, not stacked) -->
		<div class="chart-wrapper">
			<h3>Multi-Series Areas (color by series)</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<AreaMarkY
								table="area_data"
								x="x"
								y="y"
								stroke="series"
								color="series"
								fillOpacity={0.3}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Stacked areas
		<div class="chart-wrapper">
			<h3>Stacked Areas</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<AreaMarkY
								table="area_data"
								x="x"
								y="y"
								stroke="series"
								color="series"
								transforms={[stack()]}
								fillOpacity={0.7}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div> -->

		<!-- Area + Line overlay -->
		<div class="chart-wrapper">
			<h3>Area + Line Overlay</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<AreaMarkY
								table="area_data"
								x="x"
								y="y"
								transforms={[filter(eq('series', literal('Beta')))]}
								fillOpacity={0.2}
								color="#e15759"
							/>
							<LineMark
								table="area_data"
								x="x"
								y="y"
								transforms={[filter(eq('series', literal('Beta')))]}
								strokeWidth={2}
								color="#e15759"
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
