<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import MainView from './MainView.svelte';

	import { setQueryContext } from '$lib/query-engine';
	setCoordinators();

	const wasm = wasmConnector();
	const coord = new Coordinator();
	coord.databaseConnector(wasm);
	setContext('mosaic-coordinator', coord);
	let resolveConn;
	setQueryContext(new Promise((r) => { resolveConn = r; }));
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			resolveConn(await wasm.getConnection());
			// Generate synthetic time series data with DuckDB
			await coord.exec(`
				CREATE TABLE timeseries AS
				SELECT
					TIMESTAMP '2024-01-15 00:00:00' + INTERVAL (i * 3600) SECOND AS timestamp,
					100 + 50 * sin(i / 50.0) + (random() * 20 - 10) AS value,
					CASE WHEN random() > 0.5 THEN 'sensor_a' ELSE 'sensor_b' END AS sensor
				FROM generate_series(0, 999) AS t(i)
			`);

			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<div class="app-container">
	{#if loadError}
		<div class="error-container">Error: {loadError}</div>
	{:else if !isLoaded}
		<div class="loading-container">Loading time series data...</div>
	{:else}
		<MainView />
	{/if}
</div>

<style>
	.app-container {
		width: 100%;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.loading-container,
	.error-container {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 200px;
		padding: 2rem;
	}
</style>
