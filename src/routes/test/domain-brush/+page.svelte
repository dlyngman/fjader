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
			// Generate a time series: 2000 points with some interesting structure
			await coord.exec(`
				CREATE TABLE timeseries AS
				WITH RECURSIVE points AS (
					SELECT 0 as idx
					UNION ALL
					SELECT idx + 1 FROM points WHERE idx < 1999
				)
				SELECT
					idx as x,
					sin(idx * 0.02) * 10 + sin(idx * 0.005) * 20 + 2.0 * (random() - 0.5) as y
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
		<div class="status">Generating data...</div>
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
	.status {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 200px;
		padding: 2rem;
	}
</style>
