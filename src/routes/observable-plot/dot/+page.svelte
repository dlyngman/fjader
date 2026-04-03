<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import * as msql from '@uwdata/mosaic-sql';
	import { QueryEngine } from '$lib/query-engine/QueryEngine';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		DotsMark
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import QueryEngineProvider from '$lib/components/QueryEngineProvider.svelte';

	setCoordinators();

	// Create coordinator synchronously so context is available during init
	const wasm = wasmConnector();
	const coord = new Coordinator();
	coord.databaseConnector(wasm);
	setContext('mosaic-coordinator', coord);

	let isLoaded = $state(false);
	let loadError = $state(null);
	/** @type {import('$lib/query-engine/QueryEngine').QueryEngine | null} */
	let queryEngine = $state(null);

	onMount(async () => {
		try {
			const connection = await wasm.getConnection();
			queryEngine = new QueryEngine(connection);

			await coord.exec([
				msql.loadCSV('cars', `${window.location.origin}/data/cars.csv`),
				msql.loadCSV('gistemp', `${window.location.origin}/data/gistemp.csv`),
				msql.loadCSV('aapl', `${window.location.origin}/data/aapl.csv`)
			]);

			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

{#if loadError}
	<p class="status error">Error loading data: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading...</p>
{:else if queryEngine}
<QueryEngineProvider {queryEngine}>
	<div class="container">
		<h1>Scatterplot</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer>
					{#snippet background()}
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<MarginLabel />
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<DotsMark
									table="cars"
									x={msql.column('economy (mpg)')}
									y={msql.column('power (hp)')}
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

	<div class="container">
		<h1>Fuel Efficiency (derived value)</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer>
					{#snippet background()}
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<MarginLabel />
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<DotsMark
									table="cars"
									x={msql.sql`100.0 / ${msql.column('economy (mpg)')}`}
									y={msql.column('power (hp)')}
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

	<div class="container">
		<h1>Global Surface Temperature Anomaly</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer>
					{#snippet background()}
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<MarginLabel />
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<DotsMark
									table="gistemp"
									x="Date"
									y="Anomaly"
									fill="Anomaly"
									scheme="BuRd"
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

	<div class="container">
		<h1>AAPL Daily Change vs. Volume</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer>
					{#snippet background()}
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<MarginLabel />
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<DotsMark
									table="aapl"
									x={msql.sql`(${msql.column('Close')} - ${msql.column('Open')}) / ${msql.column('Open')}`}
									y="Volume"
									r="Volume"
									radiusRange={[1, 8]}
									opacity={0.3}
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
		</div>
	</div>
</QueryEngineProvider>
{/if}

<style>
	.container {
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}

	h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0 0 1.5rem 0;
	}

	.charts {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4 / 3;
		min-height: 300px;
		max-height: 600px;
		position: relative;
	}

	.status {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		font-size: 1rem;
		color: #666;
		margin: 0;
	}

	.error {
		color: red;
	}
</style>
