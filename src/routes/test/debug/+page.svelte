<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import MainView from './MainView.svelte';

	import { QueryEngine } from '$lib/query-engine/QueryEngine';
	import QueryEngineProvider from '$lib/components/QueryEngineProvider.svelte';
	setCoordinators();

	const wasm = wasmConnector();
	const coord = new Coordinator();
	coord.databaseConnector(wasm);
	setContext('mosaic-coordinator', coord);
	let isLoaded = $state(false);
	let loadError = $state(null);
	/** @type {import('$lib/query-engine/QueryEngine').QueryEngine | null} */
	let queryEngine = $state(null);

	onMount(async () => {
		try {
			const connection = await wasm.getConnection();
			queryEngine = new QueryEngine(connection);
			// Generate a dense time series: 100K points across 3 series
			await coord.exec(`
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

			// Hourly time series: 1 year across 3 series (~26K points)
			await coord.exec(`
				CREATE TABLE hourly_series AS
				WITH
					hours AS (
						SELECT ts FROM generate_series(
							TIMESTAMP '2025-01-01 00:00:00',
							TIMESTAMP '2025-12-31 23:00:00',
							INTERVAL 1 HOUR
						) t(ts)
					),
					groups AS (
						SELECT 'Group A' as grp, 1.0 as base_mult
						UNION ALL
						SELECT 'Group B', 1.4
						UNION ALL
						SELECT 'Group C', 0.6
					)
				SELECT
					q.grp,
					h.ts,
					GREATEST(1, CAST(
						q.base_mult
						-- daily: pow(cos, 2) sharpens the peak; range ~0.05 at 3am to 1.0 at 1pm
						* pow(GREATEST(0.05, 0.5 + 0.5 * cos(2.0 * 3.14159 * (EXTRACT(HOUR FROM h.ts) - 13.0) / 24.0)), 2)
						* 200.0
						* CASE EXTRACT(DOW FROM h.ts)
							WHEN 1 THEN 1.20
							WHEN 2 THEN 1.05
							WHEN 3 THEN 1.00
							WHEN 4 THEN 0.90
							WHEN 5 THEN 0.75
							WHEN 6 THEN 0.45
							WHEN 0 THEN 0.40
						END
						* (1.0 + 0.20 * sin(2.0 * 3.14159 * (EXTRACT(DOY FROM h.ts) - 60.0) / 365.0))
						* (1.0 + 0.30 * (random() - 0.5))
						+ CASE WHEN random() < 0.02 THEN 80.0 + 120.0 * random() ELSE 0.0 END
					AS INTEGER)) as value
				FROM hours h
				CROSS JOIN groups q
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
		<div class="status">Generating test data...</div>
	{:else if queryEngine}
		<QueryEngineProvider {queryEngine}>
			<MainView />
		</QueryEngineProvider>
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
