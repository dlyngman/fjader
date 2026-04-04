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
{:else if isLoaded}
	<MainView />
{:else}
	<p style="padding: 1rem;">Loading DuckDB...</p>
{/if}
