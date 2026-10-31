<script>
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';

	const { queryEngine } = initFjader();

	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			// Small aggregated dataset: 6 months x 5 categories
			await queryEngine.exec(`
				CREATE TABLE stacked_categories AS
				SELECT
					month,
					category,
					value
				FROM (
					VALUES
						('Jan', 'Electronics', 120), ('Jan', 'Clothing', 80), ('Jan', 'Food', 200), ('Jan', 'Books', 40), ('Jan', 'Sports', 60),
						('Feb', 'Electronics', 150), ('Feb', 'Clothing', 90), ('Feb', 'Food', 180), ('Feb', 'Books', 50), ('Feb', 'Sports', 70),
						('Mar', 'Electronics', 130), ('Mar', 'Clothing', 100), ('Mar', 'Food', 210), ('Mar', 'Books', 45), ('Mar', 'Sports', 80),
						('Apr', 'Electronics', 140), ('Apr', 'Clothing', 85), ('Apr', 'Food', 190), ('Apr', 'Books', 55), ('Apr', 'Sports', 65),
						('May', 'Electronics', 160), ('May', 'Clothing', 95), ('May', 'Food', 220), ('May', 'Books', 60), ('May', 'Sports', 75),
						('Jun', 'Electronics', 170), ('Jun', 'Clothing', 110), ('Jun', 'Food', 230), ('Jun', 'Books', 65), ('Jun', 'Sports', 90)
				) AS t(month, category, value)
			`);

			// Fine-resolution dataset: 500 x-positions x 5 series
			await queryEngine.exec(`
				CREATE TABLE stacked_timeseries AS
				WITH RECURSIVE
					points AS (
						SELECT 0 as idx
						UNION ALL
						SELECT idx + 1 FROM points WHERE idx < 499
					),
					series AS (
						SELECT 'Alpha' as name UNION ALL
						SELECT 'Beta' UNION ALL
						SELECT 'Gamma' UNION ALL
						SELECT 'Delta' UNION ALL
						SELECT 'Epsilon'
					)
				SELECT
					s.name as series,
					p.idx as x,
					ABS(10 + 5 * sin(p.idx * 0.05 + CASE s.name
						WHEN 'Alpha' THEN 0
						WHEN 'Beta' THEN 1.2
						WHEN 'Gamma' THEN 2.4
						WHEN 'Delta' THEN 3.6
						WHEN 'Epsilon' THEN 4.8
					END) + 2 * random()) as y
				FROM points p
				CROSS JOIN series s
				ORDER BY p.idx, s.name
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
