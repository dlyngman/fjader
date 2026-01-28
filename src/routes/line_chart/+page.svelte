<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import MainView from './MainView.svelte';

	setCoordinators();

	let coord;
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			const wasm = wasmConnector();
			coord = new Coordinator();
			coord.databaseConnector(wasm);

			coord.manager.logQueries(true);
			setContext('mosaic-coordinator', coord);

			// Create a synthetic time series dataset for testing lines
			// Multiple series with gaps and different patterns
			await coord.exec(`
				CREATE TABLE timeseries AS
				WITH RECURSIVE
					-- Generate 200 points per series
					points AS (
						SELECT 0 as idx
						UNION ALL
						SELECT idx + 1 FROM points WHERE idx < 199
					),
					-- Generate 3 series
					series AS (
						SELECT 'Series A' as name, 0 as offset, 1.0 as amplitude
						UNION ALL
						SELECT 'Series B', 50, 0.8
						UNION ALL
						SELECT 'Series C', 100, 0.6
					)
				SELECT
					s.name as series,
					p.idx as x,
					-- Create sinusoidal data with different phases and amplitudes
					-- Add some noise and gaps
					CASE
						WHEN p.idx BETWEEN 80 AND 85 AND s.name = 'Series A' THEN NULL -- Gap in Series A
						WHEN p.idx BETWEEN 120 AND 125 AND s.name = 'Series B' THEN NULL -- Gap in Series B
						ELSE s.amplitude * sin((p.idx + s.offset) * 0.1) + 0.1 * random()
					END as y
				FROM points p
				CROSS JOIN series s
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
		<div class="loading-container">Generating time series data...</div>
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
