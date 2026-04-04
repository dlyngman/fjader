<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { loadParquet } from '@uwdata/mosaic-sql';
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
			await coord.exec(loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`));

			// Synthetic timeseries for line/area facet tests
			await coord.exec(`
				CREATE TABLE facet_timeseries AS
				WITH RECURSIVE
					points AS (
						SELECT 0 as idx UNION ALL SELECT idx + 1 FROM points WHERE idx < 59
					),
					series AS (
						SELECT 'Alpha' as series, 0 as offset, 1.0 as amp
						UNION ALL SELECT 'Beta', 20, 0.7
						UNION ALL SELECT 'Gamma', 40, 0.5
					)
				SELECT
					s.series,
					p.idx as x,
					s.amp * sin((p.idx + s.offset) * 0.15) + 0.3 * random() + 2.0 as y
				FROM points p CROSS JOIN series s
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
		<div class="error-container">Error loading data: {loadError}</div>
	{:else if !isLoaded}
		<div class="loading-container">Loading parquet data...</div>
	{:else}
		<MainView />
	{/if}
</div>

<style>
	.app-container {
		width: 100%;
		height: 100vh;
		display: flex;
		flex-direction: column;
		padding: 16px;
		box-sizing: border-box;
	}
	.loading-container,
	.error-container {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		font-size: 14px;
		color: #666;
	}
	.error-container {
		color: #d32f2f;
	}
</style>
