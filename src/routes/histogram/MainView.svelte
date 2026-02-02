<script>
	import { Selection } from '@uwdata/mosaic-core';
	import { count } from '@uwdata/mosaic-sql';
	import { getContext } from 'svelte';
	import {
		ChartContainer,
		Grid,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		RectYMark
	} from '$lib/components';
	import { bin } from '$lib/sql/bin.js';

	const coordinator = getContext('mosaic-coordinator');
	const selection = Selection.crossfilter();
</script>

<div class="demo-container">
	<h2>RectYMark Histogram</h2>

	<div class="chart-wrapper">
		<ChartContainer xLabel="bill_length" yLabel="count">
			{#snippet background()}
				<MarginLabel />
			{/snippet}

			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />

						<RectYMark
							table="penguins"
							x={bin('bill_length', { steps: 50 })}
							y={count()}
							color="steelblue"
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
		<ChartContainer>
			{#snippet background()}
				<MarginLabel />
			{/snippet}

			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />

						<RectYMark
							table="travelers"
							x={bin('date', { step: 2 })}
							y={count()}
							color="steelblue"
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

<style>
	.demo-container {
		width: 100%;
		max-width: 900px;
		margin: 0 auto;
		padding: 20px;
	}

	.demo-container h2 {
		margin: 0 0 16px 0;
		font-size: 18px;
		font-weight: 600;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 300px;
		max-height: 500px;
		position: relative;
		border: 1px solid #ddd;
		border-radius: 8px;
		overflow: hidden;
	}
</style>
