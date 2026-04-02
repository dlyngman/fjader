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
		AreaMarkY,
		AreaMarkX,
		Legend
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import { stackY } from '$lib/transforms';

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

			await coord.exec([
				msql.loadCSV('aapl', `${window.location.origin}/data/aapl.csv`),
				msql.loadCSV('sftemp', `${window.location.origin}/data/sf-temperatures.csv`),
				msql.loadCSV('unemployment', `${window.location.origin}/data/bls-industry-unemployment.csv`),
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
{:else}
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
								<AreaMarkY
									table="aapl"
									x="Date"
									y="Close"
									curve="monotone"
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

	<div class="container">
		<h1>SF Temperature Band</h1>

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
								<AreaMarkY
									table="sftemp"
									x="date"
									y1="low"
									y2="high"
									curve="monotone"
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
								<AreaMarkY table="random_walk" x="i" y="value" curve="monotone" />
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
		<h1>AAPL Stock Price (vertical)</h1>

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
								<AreaMarkX
									table="aapl"
									y="Date"
									x="Close"
									fillOpacity={0.3}
									curve="monotone"
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

	<div class="container">
		<h1>Industry Unemployment (stacked)</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer legendPosition="top" xLabel="date (unemployment)">
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
								<AreaMarkY
									table="unemployment"
									x="date"
									y="unemployed"
									fill="industry"
									fillOpacity={1}
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
		<h1>Industry Unemployment (centered)</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer legendPosition="top" xLabel="date (unemployment)">
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
								<AreaMarkY
									table="unemployment"
									x="date"
									y="unemployed"
									fill="industry"
									fillOpacity={1}
									curve="monotone"
									transforms={[stackY({ offset: 'center' })]}
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
		<h1>Industry Unemployment (overlapping)</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer legendPosition="top" xLabel="date (unemployment)">
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
								<AreaMarkY
									table="unemployment"
									x="date"
									y1={0}
									y2="unemployed"
									z="industry"
									fill="industry"
									fillOpacity={0.1}
									curve="monotone"
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
		<h1>Area with Missing Data</h1>

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
								<AreaMarkY
									table="aapl"
									x="Date"
									y={msql.sql`CASE WHEN EXTRACT(MONTH FROM ${msql.column('Date')}) < 4 THEN NULL ELSE ${msql.column('Close')} END`}
									curve="monotone"
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

	<div class="container">
		<h1>Variable Fill Area</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer xLabel="Date (aapl-vfill)" legendPosition="top">
					{#snippet legend()}
						<Legend color="Volume" />
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
								<AreaMarkY
									table="aapl"
									x="Date"
									y="Close"
									fill={{ field: 'Volume', type: 'log' }}
									fillOpacity={1}
									scheme="turbo"
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
