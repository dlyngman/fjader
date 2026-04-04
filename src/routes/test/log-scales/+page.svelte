<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import MainView from './MainView.svelte';

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
			// Generate data for log/symlog scale testing
			await coord.exec(`
				CREATE TABLE log_data AS
				WITH RECURSIVE
					points AS (
						SELECT 0 as idx
						UNION ALL
						SELECT idx + 1 FROM points WHERE idx < 499
					)
				SELECT
					idx as id,
					-- Exponentially distributed x values (1 to ~150,000)
					POWER(10, idx * 5.0 / 499) as population,
					-- Exponential y for log-y line/area charts
					POWER(10, idx * 3.0 / 499) * (1.0 + 0.3 * sin(idx * 0.1)) as value,
					-- Some noisy linear-ish y (for log-x scatter)
					50 + 20 * sin(idx * 0.05) + 10 * random() as gdp,
					-- Values that cross zero (for symlog): linear spread from -1000 to +1000
					(idx - 250) * 4.0 as profit,
					-- Large-magnitude zero-crossing (for symlog with custom constant)
					(idx - 250) * 400.0 as revenue,
					-- Near-zero values for boundary testing (1e-12 to 1e-8)
					POWER(10, -12 + idx * 4.0 / 499) as tiny,
					-- Categorical
					CASE WHEN idx % 3 = 0 THEN 'A' WHEN idx % 3 = 1 THEN 'B' ELSE 'C' END as category
				FROM points
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
		<div class="status">Error: {loadError}</div>
	{:else if !isLoaded}
		<div class="status">Generating log scale test data...</div>
	{:else if queryEngine}
		<QueryEngineProvider {queryEngine}>
			<MainView />
		</QueryEngineProvider>
	{/if}
</div>

<style>
	.app-container {
		padding: 20px;
		font-family: system-ui, sans-serif;
	}
	.status {
		padding: 20px;
		text-align: center;
		color: #666;
	}
</style>
