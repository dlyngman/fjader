<script>
	/**
	 * A scale replaced under a mounted mark: the x column (and with it xLabel,
	 * the scale's registry key) comes from the dropdown, so each switch hands
	 * the chart a different x scale. The mark must rebuild its lifecycle and
	 * draw on the new axis. Marks rebuild on ChartContext.scaleGeneration,
	 * which counts replacements only (not a scale's first resolution).
	 */
	import * as msql from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		DotsMark
	} from '$lib/components';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let xColumn = $state('bill_length');

	onMount(async () => {
		await queryEngine.exec(
			msql.loadParquet('penguins', `${location.origin}/data/penguins.parquet`).toString()
		);
		isLoaded = true;
	});
</script>

<div class="page">
	<label>
		x column
		<select bind:value={xColumn}>
			<option value="bill_length">bill_length (32–60)</option>
			<option value="flipper_length">flipper_length (172–231)</option>
			<option value="body_mass">body_mass (2700–6300)</option>
		</select>
	</label>
	{#if isLoaded}
		<div class="chart">
			<ChartContainer xLabel={xColumn} yLabel="bill_depth">
				{#snippet background()}
					<Frame />
					<AxisLeft />
					<AxisBottom />
					<MarginLabel />
				{/snippet}
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<DotsMark table="penguins" x={xColumn} y="bill_depth" fill="species" r={3} />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
			</ChartContainer>
		</div>
	{/if}
</div>

<style>
	.page {
		padding: 1.5rem;
		font-family: system-ui, sans-serif;
	}
	.chart {
		width: 640px;
		height: 380px;
		margin-top: 1rem;
	}
</style>
