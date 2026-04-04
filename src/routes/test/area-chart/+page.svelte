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
			// Create synthetic time series dataset with multiple series
			await coord.exec(`
				CREATE TABLE area_data AS
				WITH RECURSIVE
					points AS (
						SELECT 0 as idx
						UNION ALL
						SELECT idx + 1 FROM points WHERE idx < 99
					),
					series AS (
						SELECT 'Alpha' as name, 0 as phase, 2.0 as amplitude
						UNION ALL
						SELECT 'Beta', 30, 1.5
						UNION ALL
						SELECT 'Gamma', 60, 1.0
					)
				SELECT
					s.name as series,
					p.idx as x,
					s.amplitude * (1.0 + sin((p.idx + s.phase) * 0.08)) + 0.5 as y
				FROM points p
				CROSS JOIN series s
				ORDER BY s.name, p.idx
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
		<div class="loading-container">Generating area chart data...</div>
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
