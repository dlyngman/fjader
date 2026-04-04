<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { loadParquet, count, dateMonthDay } from '@uwdata/mosaic-sql';
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
		DotsMark,
		IntervalX,
		Legend} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import BarMarkX from '$lib/components/marks/BarMarkX.svelte';
	import Toggle from '$lib/interactors/Toggle.svelte';

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
			await coord.exec(
				loadParquet('weather', `${window.location.origin}/data/seattle-weather.parquet`)
			);

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
		<h1>Seattle Weather</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer legendPosition="top">
					{#snippet legend()}
						<Legend color="weather" selection="brush" />
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
								<DotsMark
									table="weather"
									x={dateMonthDay('date')}
									y="temp_max"
									fill="weather"
									r="precipitation"
									preferredXScaleType="time"
									selection="brush"
									domain={{ y: ["sun", "fog", "drizzle", "rain", "snow"] }}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
					{/snippet}

					{#snippet interactors()}
						<IntervalX selection="brush" field={dateMonthDay('date')} />
					{/snippet}
				</ChartContainer>
			</div>

			<div class="chart-wrapper">
				<ChartContainer>
					<!-- {#snippet legend()}
						<Legend color="weather" selection="brush" />
					{/snippet} -->
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
								<BarMarkX
									table="weather"
									x={count()}
									y="weather"
									fill="weather"
									selection="brush"
									domain={{ y: ["sun", "fog", "drizzle", "rain", "snow"] }}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
					{/snippet}

					{#snippet interactors()}
						<Toggle selection="brush" field="weather" />
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>
</QueryEngineProvider>
{/if}

<style>
	.container {
		max-width: 1200px;
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
		max-height: 400px;
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
