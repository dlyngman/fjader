<script>
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';


	const { queryEngine } = initDivePlot();

	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec(loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString());

			// Synthetic time series for line/area marks
			await queryEngine.exec(`
				CREATE TABLE timeseries AS
				WITH RECURSIVE
					points AS (
						SELECT 0 as idx
						UNION ALL
						SELECT idx + 1 FROM points WHERE idx < 99
					),
					series AS (
						SELECT 'A' as series, 0 as offset, 1.0 as amp
						UNION ALL SELECT 'B', 30, 0.7
						UNION ALL SELECT 'C', 60, 0.5
					)
				SELECT
					s.series,
					p.idx as x,
					s.amp * sin((p.idx + s.offset) * 0.12) + 0.05 * random() as y
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
		<div class="status">Error: {loadError}</div>
	{:else if !isLoaded}
		<div class="status">Loading data...</div>
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
