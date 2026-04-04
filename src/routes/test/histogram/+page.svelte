<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { loadParquet } from '@uwdata/mosaic-sql';
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
			await coord.exec([
				loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`),
				loadParquet('travelers', `${window.location.origin}/data/travelers.parquet`)
			]);

			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<div class="app-container">
	{#if loadError}
		<div class="loading-container">Error loading data: {loadError}</div>
	{:else if !isLoaded}
		<div class="loading-container">Loading parquet data...</div>
	{:else if queryEngine}
		<QueryEngineProvider {queryEngine}>
			<MainView />
		</QueryEngineProvider>
	{/if}
</div>

<style>
	.app-container {
		width: 100%;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.loading-container {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 200px;
		padding: 2rem;
	}
</style>
