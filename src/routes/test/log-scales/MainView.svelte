<script>
	import { getContext } from 'svelte';
	import {
		ChartContainer,
		Grid,
		Crosshair,
		WebGPUCanvas,
		DotsMark,
		AxisBottom,
		AxisLeft,
		MarginLabel
	} from '$lib/components';

	const coordinator = getContext('mosaic-coordinator');
</script>

<div class="main-view-container">
	<h2>Log and Symlog Scale Test</h2>

	<div class="charts-grid">
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
