<script>
	import { Coordinator, coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { loadCSV, loadParquet } from '@uwdata/mosaic-sql';
	// import { setScaleRegistry } from "$lib/scales";
	import { setCoordinators } from '$lib';
	import { onMount, onDestroy, setContext } from 'svelte';
	import MainView from './MainView.svelte';

	import { QueryEngine } from '$lib/query-engine/QueryEngine';
	import QueryEngineProvider from '$lib/components/QueryEngineProvider.svelte';
	// setScaleRegistry();
	setCoordinators();

	const wasm = wasmConnector();
	const coord = new Coordinator();
	coord.databaseConnector(wasm);
	setContext('mosaic-coordinator', coord);
	//
	let isLoaded = $state(false);
	let loadError = $state(null);
	/** @type {import('$lib/query-engine/QueryEngine').QueryEngine | null} */
	let queryEngine = $state(null);

	const logs = [];
	const queryLogger = {
		...console,

		debug(...values) {
			if (values.length > 0 && typeof values[0] === 'string' && values[0].includes('Query')) {
				const queryLog = values[1];

				if (queryLog && queryLog.sql) {
					const timestamp = new Date().toLocaleTimeString('sv-SE', { hour12: false });
					console.log(`[${timestamp}] \n${queryLog.sql}`);
					logs.push({ query: queryLog.sql, time: new Date() });
				}
			}
		},
		getLogs() {
			return logs;
		}
	};

	onMount(async () => {
		try {
			const connection = await wasm.getConnection();
			queryEngine = new QueryEngine(connection);

			await coord.exec(
				loadParquet('travelers', `${window.location.origin}/data/travelers.parquet`)
			);

			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<div class="app-container">
	{#if loadError}
		<div class="error-container">Error loading data: {loadError}</div>
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

	.loading-container,
	.error-container {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 200px;
		padding: 2rem;
	}
</style>
