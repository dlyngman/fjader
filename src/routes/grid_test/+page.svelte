<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import {
		ChartContainer,
		// Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		DotsMark
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';

	setCoordinators();

	let coord;
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			const wasm = wasmConnector();
			coord = new Coordinator();
			coord.databaseConnector(wasm);
			setContext('mosaic-coordinator', coord);

			await coord.exec(loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`));

			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<div class="app-container">
	{#if loadError}
		<div class="error-container">Error loading data: {loadError}</div>
	{:else if !isLoaded}
		<div class="loading-container">Loading parquet data...</div>
	{:else}
		<div class="demo-container">
			<h1>GPU Grid Test</h1>
			<p>Testing the new hybrid Grid architecture (GPU lines + SVG axes)</p>

			<div class="chart-wrapper">
				<ChartContainer xLabel="Bill Length (mm)" yLabel="Bill Depth (mm)">
					{#snippet background()}
						<!-- <Frame /> -->
						<MarginLabel />
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<!-- GPU Grid Lines (both axes) -->
								<Grid />

								<!-- Data Points -->
								<DotsMark
									table="penguins"
									x="bill_length"
									y="bill_depth"
									color="species"
									alpha={0.7}
									radius={4}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<!-- <AxisLeft /> -->
						<!-- <AxisBottom /> -->
					{/snippet}
				</ChartContainer>
			</div>

			<div class="info">
				<h3>What's different:</h3>
				<ul>
					<li>
						<strong>Grid lines are GPU-rendered</strong> - perfectly synchronized with data during pan/zoom
					</li>
					<li><strong>Axes remain SVG</strong> - crisp text and accessibility</li>
					<li><strong>Zero lag</strong> - grid and data move together at 120fps</li>
				</ul>
			</div>
		</div>
	{/if}
</div>

<style>
	.app-container {
		width: 100%;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		background: #fafafa;
	}

	.demo-container {
		max-width: 1200px;
		margin: 0 auto;
		padding: 40px 20px;
	}

	h1 {
		font-size: 32px;
		font-weight: 700;
		margin: 0 0 8px 0;
	}

	p {
		color: #666;
		margin: 0 0 32px 0;
	}

	.chart-wrapper {
		width: 100%;
		height: 600px;
		background: white;
		border-radius: 12px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
		overflow: hidden;
		margin-bottom: 32px;
	}

	.info {
		background: white;
		border-radius: 12px;
		padding: 24px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	}

	.info h3 {
		margin: 0 0 16px 0;
		font-size: 18px;
		font-weight: 600;
	}

	.info ul {
		margin: 0;
		padding-left: 24px;
	}

	.info li {
		margin-bottom: 8px;
		line-height: 1.6;
	}

	.loading-container,
	.error-container {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		font-size: 18px;
	}

	.error-container {
		color: red;
	}
</style>
