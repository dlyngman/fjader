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
			// Generate 50K normally-distributed values for histogram testing
			await coord.exec(`
				CREATE TABLE histogram_data AS
				SELECT
					(random() + random() + random() + random() + random() + random()
					 - 3.0) * 20.0 + 50.0 as value,
					CASE WHEN random() < 0.5 THEN 'Group A' ELSE 'Group B' END as category
				FROM generate_series(1, 50000)
			`);

			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<svelte:head>
	<title>Binned LOD Test</title>
</svelte:head>

{#if loadError}
	<p style="color: red; padding: 1rem;">Error: {loadError}</p>
{:else if isLoaded && queryEngine}
	<QueryEngineProvider {queryEngine}>
		<MainView />
	</QueryEngineProvider>
{:else}
	<p style="padding: 1rem;">Loading DuckDB...</p>
{/if}
