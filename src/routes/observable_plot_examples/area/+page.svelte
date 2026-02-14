<script>
	import { Coordinator, wasmConnector, Selection } from '@uwdata/mosaic-core';
	import { loadParquet, loadCSV, count, dateMonthDay } from '@uwdata/mosaic-sql';
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
        AreaMarkY,
        LineMark,
		IntervalX,
		FilterBridge,
		Legend
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import BarMarkX from '$lib/components/marks/BarMarkX.svelte';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import { eq, literal, sql } from '@uwdata/mosaic-sql';
	import { filter, stack } from '$lib/transforms';


	setCoordinators();

	let coord;
	let isLoaded = $state(false);
	let loadError = $state(null);

	const filterBridge = new FilterBridge(Selection, null);

	onMount(async () => {
		try {
			const wasm = wasmConnector();
			coord = new Coordinator();
			coord.databaseConnector(wasm);
			setContext('mosaic-coordinator', coord);

			await coord.exec([
				// loadParquet('weather', `${window.location.origin}/data/seattle-weather.parquet`)
				loadCSV('aapl', `${window.location.origin}/data/aapl.csv`),
				loadCSV('sftemp', `${window.location.origin}/data/sf-temperatures.csv`)
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
		<h1>Seattle Weather</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer legendPosition="top">
					{#snippet legend()}
						<Legend color="weather" bridge={filterBridge} />
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
                                    dotRadius={3}
                                    curve="monotone"
                                    strokeWidth={2}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
					{/snippet}

					{#snippet interactors()}
						<!-- <IntervalX bridge={filterBridge} field={dateMonthDay('date')} /> -->
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>
    <div class="container">
		<h1>SF temp</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer legendPosition="top">
					{#snippet legend()}
						<Legend color="weather" bridge={filterBridge} />
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
									table="sftemp"
									x="date"
									y1="low"
									y2="high"
                                    dotRadius={3}
                                    curve="monotone"
                                    strokeWidth={2}
                                />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
					{/snippet}

					{#snippet interactors()}
						<!-- <IntervalX bridge={filterBridge} field={dateMonthDay('date')} /> -->
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>
{/if}

<style>
	.container {
		/* max-width: 1400px; */
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
