<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import * as msql from '@uwdata/mosaic-sql';
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
		LineMark,
		DotsMark,
		Legend
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';

	import { QueryEngine } from '$lib/query-engine/QueryEngine';
	import QueryEngineProvider from '$lib/components/QueryEngineProvider.svelte';
	setCoordinators();

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
				msql.loadCSV('aapl', `${window.location.origin}/data/aapl.csv`),
				msql.loadCSV('unemployment', `${window.location.origin}/data/bls-industry-unemployment.csv`),
				msql.loadCSV('driving', `${window.location.origin}/data/driving.csv`),
				msql.loadCSV('sftemp', `${window.location.origin}/data/sf-temperatures.csv`),
				`CREATE TABLE random_walk AS SELECT i, SUM(random() - 0.5) OVER (ORDER BY i) AS value FROM generate_series(1, 600) AS t(i)`
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
		<h1>AAPL Stock Price</h1>

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
								<LineMark
									table="aapl"
									x="Date"
									y="Close"
									curve="monotone"
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
		<h1>Industry Unemployment</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer legendPosition="top">
					{#snippet legend()}
						<Legend color="industry" />
					{/snippet}
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
								<LineMark
									table="unemployment"
									x="date"
									y="unemployed"
									stroke="industry"
									strokeWidth={1}
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
		<h1>Line with Missing Data</h1>

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
								<LineMark
									table="aapl"
									x="Date"
									y={msql.sql`CASE WHEN EXTRACT(MONTH FROM ${msql.column('Date')}) < 4 THEN NULL ELSE ${msql.column('Close')} END`}
									curve="monotone"
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
		<h1>Random Walk</h1>

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
								<LineMark table="random_walk" x="i" y="value" curve="monotone" />
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
		<h1>Connected Scatterplot</h1>

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
								<LineMark
									table="driving"
									x="miles"
									y="gas"
									order="year"
									curve="catmull-rom"
								/>
								<DotsMark
									table="driving"
									x="miles"
									y="gas"
									r={3}
									fill="black"
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
		<h1>SF Temperature (Moving Average)</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer xLabel="date (sftemp)" yLabel="Temperature (°F)">
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
								<LineMark
									table="sftemp"
									x="date"
									y="low"
									stroke="steelblue"
									lod={{ smooth: { window: 7 }, dots: false }}
								/>
								<LineMark
									table="sftemp"
									x="date"
									y="high"
									stroke="orange"
									lod={{ smooth: { window: 7 }, dots: false }}
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
		aspect-ratio: 2 / 1;
		min-height: 200px;
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
