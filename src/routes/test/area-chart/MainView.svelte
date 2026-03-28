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
	<p>Testing: AreaMarkY with curve types, stroke outlines, and line overlay</p>

	<div class="charts-grid">
		<!-- Linear (default) -->
		<div class="chart-wrapper">
			<h3>Linear (default)</h3>
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
								fill="#4e79a7"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Monotone area (recommended for data viz) -->
		<div class="chart-wrapper">
			<h3>Monotone Area (no overshoot)</h3>
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
								curve="monotone"
								fillOpacity={0.4}
								fill="#4e79a7"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Catmull-Rom area (may overshoot) -->
		<div class="chart-wrapper">
			<h3>Catmull-Rom Area (overshoots)</h3>
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
								curve="catmull-rom"
								fillOpacity={0.4}
								fill="#4e79a7"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Bump area -->
		<div class="chart-wrapper">
			<h3>Bump Area</h3>
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
								curve="bump"
								fillOpacity={0.4}
								fill="#76b7b2"
								dotRadius={4}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Bump line -->
		<div class="chart-wrapper">
			<h3>Bump Line</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="area_data"
								x="x"
								y="y"
								stroke="series"
								curve="bump"
								strokeWidth={2}
								dotRadius={4}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Step area -->
		<div class="chart-wrapper">
			<h3>Step Area</h3>
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
								curve="step"
								fillOpacity={0.4}
								fill="#e15759"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Monotone area with stroke outline -->
		<div class="chart-wrapper">
			<h3>Monotone + Stroke Outline</h3>
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
								curve="monotone"
								fillOpacity={0.3}
								fill="#59a14f"
								strokeWidth={2}
								stroke="#2d5a27"
								dotRadius={5}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Monotone line -->
		<div class="chart-wrapper">
			<h3>Monotone Line</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="area_data"
								x="x"
								y="y"
								transforms={[filter(eq('series', literal('Gamma')))]}
								curve="monotone"
								strokeWidth={2}
								stroke="#f28e2b"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Step line -->
		<div class="chart-wrapper">
			<h3>Step Line</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="area_data"
								x="x"
								y="y"
								transforms={[filter(eq('series', literal('Gamma')))]}
								curve="step"
								strokeWidth={2}
								stroke="#f28e2b"
								dotRadius={3}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Multi-series with monotone -->
		<div class="chart-wrapper">
			<h3>Multi-Series Monotone</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<AreaMarkY
								table="area_data"
								x="x"
								y="y"
								fill="series"
								curve="monotone"
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

		<!-- Multi-series stroke outline inheriting color -->
		<div class="chart-wrapper">
			<h3>Multi-Series + Stroke (inherit color)</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<AreaMarkY
								table="area_data"
								x="x"
								y="y"
								fill="series"
								curve="monotone"
								fillOpacity={0.2}
								strokeWidth={2}
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
