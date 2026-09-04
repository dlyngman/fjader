<script>
	import { initDivePlot } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';


	const { queryEngine } = initDivePlot();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			// Generate 50K events spanning 6 months with second-level timestamps
			await queryEngine.exec(`
				CREATE TABLE events AS
				SELECT
					'2024-01-01'::TIMESTAMP + INTERVAL (floor(random() * 180 * 24 * 3600)::INT) SECOND AS timestamp,
					random() * 100 AS value,
					CASE floor(random() * 3)::INT WHEN 0 THEN 'A' WHEN 1 THEN 'B' ELSE 'C' END AS category
				FROM generate_series(1, 50000)
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
		<div class="status">Generating 50K events...</div>
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
