<script>
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';

	const { queryEngine, gpuCoordinator } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			// Generate a time series: 2000 points with some interesting structure
			await queryEngine.exec(`
				CREATE TABLE timeseries AS
				WITH RECURSIVE points AS (
					SELECT 0 as idx
					UNION ALL
					SELECT idx + 1 FROM points WHERE idx < 1999
				)
				SELECT
					idx as x,
					sin(idx * 0.02) * 10 + sin(idx * 0.005) * 20 + idx * 0.03 + 2.0 * (random() - 0.5) as y
				FROM points
			`);
			// Two series for the ?below=1 stacked chart, whose JS stack makes its
			// fit read the tooltip table (the fitDomain path for JS transforms),
			// and the sorted bars. `a` rises with x (the line's trend) and `b`
			// falls, more slowly: the stack still rises, so its fit changes with
			// the brush, and keeping only `b` reverses the bars' order: a reorder.
			await queryEngine.exec(`
				CREATE TABLE timeseries_split AS
				SELECT x, 'a' AS series, abs(y) AS y, 'q' || (x // 250) AS bucket FROM timeseries
				UNION ALL
				SELECT x, 'b' AS series, 5 + (1999 - x) * 0.015 AS y, 'q' || (x // 250) AS bucket
				FROM timeseries
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
		<MainView {queryEngine} {gpuCoordinator} />
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
