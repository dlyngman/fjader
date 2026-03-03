<script>
	import { getContext } from 'svelte';
	import {
		ChartContainer,
		Grid,
		Crosshair,
		WebGPUCanvas,
		DotsMark,
		LineMark,
		AreaMarkY,
		AxisBottom,
		AxisLeft,
		MarginLabel
	} from '$lib/components';

	const coordinator = getContext('mosaic-coordinator');
</script>

<div class="main-view-container">
	<h2>Log and Symlog Scale Test</h2>

	<div class="charts-grid">
		<!-- 1. Original: Log X, Linear Y scatter -->
		<div class="chart-wrapper">
			<h3>Log X, Linear Y (scatter)</h3>
			<p>X axis should show powers of 10. Pan/zoom should feel uniform.</p>
			<ChartContainer xLabel="population_1" yLabel="gdp_1">
				{#snippet background()}
					<AxisBottom />
					<AxisLeft />
					<MarginLabel />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<DotsMark
								table="log_data"
								x="population"
								y="gdp"
								fill="category"
								r={4}
								preferredXScaleType="log"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- 2. Original: Log-Log scatter -->
		<div class="chart-wrapper">
			<h3>Log-Log (both axes log)</h3>
			<p>Both axes should have log ticks. Power-law data should appear linear.</p>
			<ChartContainer xLabel="population_2" yLabel="gdp_2">
				{#snippet background()}
					<AxisBottom />
					<AxisLeft />
					<MarginLabel />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<DotsMark
								table="log_data"
								x="population"
								y="gdp"
								fill="category"
								r={4}
								preferredXScaleType="log"
								preferredYScaleType="log"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- 3. Original: Symlog X (crosses zero) -->
		<div class="chart-wrapper">
			<h3>Symlog X (data crosses zero)</h3>
			<p>Handles negative, zero, and positive values. Linear near zero, log far from zero.</p>
			<ChartContainer xLabel="profit_3" yLabel="gdp_3">
				{#snippet background()}
					<AxisBottom />
					<AxisLeft />
					<MarginLabel />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<DotsMark
								table="log_data"
								x="profit"
								y="gdp"
								fill="category"
								r={4}
								preferredXScaleType="symlog"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- 4. NEW: LineMark with log Y axis -->
		<div class="chart-wrapper">
			<h3>LineMark with Log Y</h3>
			<p>
				Line chart with exponential data on a log Y axis. Should appear roughly linear with noise.
			</p>
			<ChartContainer xLabel="id_4" yLabel="value_4">
				{#snippet background()}
					<AxisBottom />
					<AxisLeft />
					<MarginLabel />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="log_data"
								x="id"
								y="value"
								stroke="category"
								preferredYScaleType="log"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- 5. NEW: AreaMarkY with log Y axis -->
		<div class="chart-wrapper">
			<h3>AreaMarkY with Log Y</h3>
			<p>Area chart with exponential data. Explicit y1=1 baseline (log-safe). No stack.</p>
			<ChartContainer xLabel="id_5" yLabel="value_5">
				{#snippet background()}
					<AxisBottom />
					<AxisLeft />
					<MarginLabel />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<AreaMarkY table="log_data" x="id" y2="value" y1={1} preferredYScaleType="log" />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- 6. NEW: Mixed log X + symlog Y -->
		<div class="chart-wrapper">
			<h3>Mixed: Log X + Symlog Y</h3>
			<p>Tests different nonlinear scale types on each axis simultaneously.</p>
			<ChartContainer xLabel="population_6" yLabel="profit_6">
				{#snippet background()}
					<AxisBottom />
					<AxisLeft />
					<MarginLabel />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<DotsMark
								table="log_data"
								x="population"
								y="profit"
								fill="category"
								r={4}
								preferredXScaleType="log"
								preferredYScaleType="symlog"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- 7. NEW: Symlog with large magnitude data -->
		<div class="chart-wrapper">
			<h3>Symlog X (large magnitude, -100K to +100K)</h3>
			<p>Symlog with wider data range. Verify uniform pan/zoom and correct tick formatting.</p>
			<ChartContainer xLabel="revenue_7" yLabel="gdp_7">
				{#snippet background()}
					<AxisBottom />
					<AxisLeft />
					<MarginLabel />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<DotsMark
								table="log_data"
								x="revenue"
								y="gdp"
								fill="category"
								r={4}
								preferredXScaleType="symlog"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- 8. NEW: Near-zero boundary data with log scale -->
		<div class="chart-wrapper">
			<h3>Log scale near clamp boundary</h3>
			<p>Data from 1e-12 to 1e-8. Tests behavior near LOG_MIN_CLAMP (1e-10).</p>
			<ChartContainer xLabel="tiny_8" yLabel="gdp_8">
				{#snippet background()}
					<AxisBottom />
					<AxisLeft />
					<MarginLabel />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<DotsMark
								table="log_data"
								x="tiny"
								y="gdp"
								fill="category"
								r={4}
								preferredXScaleType="log"
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
		max-width: 1200px;
		margin: 0 auto;
	}

	.charts-grid {
		display: flex;
		flex-direction: column;
		gap: 32px;
	}

	.chart-wrapper {
		height: 350px;
	}

	.chart-wrapper h3 {
		margin: 0 0 4px 0;
		font-size: 14px;
	}

	.chart-wrapper p {
		margin: 0 0 8px 0;
		font-size: 12px;
		color: #666;
	}

	h2 {
		margin: 0 0 20px 0;
	}
</style>
