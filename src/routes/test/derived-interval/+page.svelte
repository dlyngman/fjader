<script>
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';


	const { queryEngine } = initFjader();

	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			// Generate 2 years of hourly time series with 2 groups
			await queryEngine.exec(`
				CREATE TABLE timeseries AS
				WITH hours AS (
					SELECT
						'2023-01-01'::TIMESTAMP + INTERVAL (i) HOUR AS ts,
						i AS idx
					FROM generate_series(0, 17519) AS t(i)
				)
				SELECT
					ts,
					EXTRACT(HOUR FROM ts)::INT AS hour,
					g.name AS grp,
					50.0 * g.mult
						* (1.0 + 0.3 * sin(EXTRACT(DOY FROM ts) * 2 * PI() / 365))
						* (0.5 + 0.5 * cos((EXTRACT(HOUR FROM ts) - 13) * PI() / 12))
						* (1.0 + 1.0 * (idx::DOUBLE / 17519))
						+ (CASE WHEN ts >= '2024-01-01' THEN 15.0 * sin((EXTRACT(HOUR FROM ts) - 10) * PI() / 12) ELSE 0 END)
					AS value
				FROM hours
				CROSS JOIN (
					VALUES ('Alpha', 1.0), ('Beta', 0.7)
				) AS g(name, mult)
			`);

			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<div class="app-container">
	<h2>Derived Interval Test</h2>
	<p>
		Draw a brush on the overview. A ghost overlay should appear 1 year earlier.
		The detail chart zooms to the primary selection.
	</p>
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
		padding: 1rem;
	}
	.status {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 200px;
		padding: 2rem;
	}
	h2, p {
		margin: 0.5rem 0;
	}
</style>
