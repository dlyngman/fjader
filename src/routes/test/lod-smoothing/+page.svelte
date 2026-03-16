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
			setContext('mosaic-coordinator', coord);

			// Generate a noisy time series: 50K points across 2 series
			await coord.exec(`
				CREATE TABLE noisy_timeseries AS
				WITH RECURSIVE
					points AS (
						SELECT 0 as idx
						UNION ALL
						SELECT idx + 1 FROM points WHERE idx < 24999
					),
					series AS (
						SELECT 'Sensor A' as name, 0 as series_id, 0.0 as phase
						UNION ALL
						SELECT 'Sensor B', 1, 1.5
					)
				SELECT
					s.name as series,
					TIMESTAMP '2024-01-01' + INTERVAL (p.idx * 60) SECOND as time,
					s.series_id * 10.0
						+ 5.0 * sin(p.idx * 0.002 + s.phase)
						+ 2.0 * sin(p.idx * 0.01)
						+ 3.0 * (random() - 0.5) as value
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
		<div class="status">Error: {loadError}</div>
	{:else if !isLoaded}
		<div class="status">Generating 50K points...</div>
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
