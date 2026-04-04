<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import MainView from './MainView.svelte';

	import { setQueryContext } from '$lib/query-engine';
	setCoordinators();

	// Create coordinator synchronously so context is available
	const wasm = wasmConnector();
	const coord = new Coordinator();
	coord.databaseConnector(wasm);

	// Set context synchronously during initialization
	setContext('mosaic-coordinator', coord);
	let resolveConn;
	setQueryContext(new Promise((r) => { resolveConn = r; }));

	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			resolveConn(await wasm.getConnection());

			// Load penguins dataset for the brush demo
			await coord.exec(loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`));

			isLoaded = true;
		} catch (error) {
			console.error('Failed to initialize Mosaic:', error);
			loadError = error.message;
		}
	});
</script>

{#if loadError}
	<div style="padding: 2rem; color: red;">
		<h2>Error loading data</h2>
		<p>{loadError}</p>
	</div>
{:else if isLoaded}
	<MainView />
{:else}
	<div style="padding: 2rem;">Loading DuckDB and penguins dataset...</div>
{/if}
