<script>
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';


	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			// Generate a dense time series: 100K points across 3 series
			await queryEngine.exec(`
				CREATE TABLE dense_timeseries AS
				WITH RECURSIVE
					points AS (
						SELECT 0 as idx
						UNION ALL
						SELECT idx + 1 FROM points WHERE idx < 33332
					),
					series AS (
						SELECT 'Series A' as name, 0 as series_id, 0.0 as phase
						UNION ALL
						SELECT 'Series B', 1, 2.094
						UNION ALL
						SELECT 'Series C', 2, 4.189
					)
				SELECT
					s.name as series,
					p.idx * 0.001 as x,
					s.series_id * 2.0 + sin(p.idx * 0.01 + s.phase) + 0.5 * sin(p.idx * 0.05) + 0.1 * random() as y
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
		<div class="status">Generating 100K points...</div>
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
