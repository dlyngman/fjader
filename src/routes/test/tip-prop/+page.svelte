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

			// Synthetic line data with extra metadata columns
			await queryEngine.exec(`
				CREATE TABLE sales AS
				WITH RECURSIVE
					months AS (
						SELECT 1 as month
						UNION ALL
						SELECT month + 1 FROM months WHERE month < 12
					),
					regions AS (
						SELECT 'North' as region, 'US' as country
						UNION ALL SELECT 'South', 'US'
						UNION ALL SELECT 'East', 'UK'
						UNION ALL SELECT 'West', 'UK'
					)
				SELECT
					r.region,
					r.country,
					m.month,
					ROUND(100 + 50 * sin(m.month * 0.5 + CASE r.region
						WHEN 'North' THEN 0
						WHEN 'South' THEN 1.5
						WHEN 'East' THEN 3.0
						WHEN 'West' THEN 4.5
					END) + 20 * random(), 1) as revenue
				FROM months m
				CROSS JOIN regions r
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
