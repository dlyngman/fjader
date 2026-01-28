<script>
	import { getContext } from 'svelte';
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

	const coordinator = getContext('mosaic-coordinator');
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
							color="sensor"
							alpha={0.6}
							radius={4}
							preferredXScaleType="time"
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
