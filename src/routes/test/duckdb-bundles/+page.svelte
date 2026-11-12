<script lang="ts">
	/**
	 * The three ways to get DuckDB-WASM into initFjader():
	 *   ?mode=cdn    initFjader()                          jsDelivr bundles (default)
	 *   ?mode=local  initFjader({ bundles })               bundles served by this app (Vite ?url)
	 *   ?mode=own    initFjader(connectionFrom(conn))      app-owned AsyncDuckDB; the parquet is
	 *                                                      fetched once and registered with
	 *                                                      registerFileBuffer, as a cache would
	 * Check the Network tab: in local and own modes no request goes to cdn.jsdelivr.net.
	 */
	import { count } from '@uwdata/mosaic-sql';
	import * as duckdb from '@duckdb/duckdb-wasm';
	import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
	import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
	import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
	import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { initFjader, connectionFrom } from '$lib';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		BarMarkY
	} from '$lib/components';

	const bundles: duckdb.DuckDBBundles = {
		mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
		eh: { mainModule: ehWasm, mainWorker: ehWorker }
	};

	const mode = page.url.searchParams.get('mode') ?? 'cdn';
	const parquetUrl = '/data/flights-200k.parquet';

	/** What an app with its own DuckDB does: keep `db`, register cached bytes, then hand over. */
	async function ownConnection() {
		const bundle = await duckdb.selectBundle(bundles);
		const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker!));
		await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
		const bytes = new Uint8Array(await (await fetch(parquetUrl)).arrayBuffer());
		await db.registerFileBuffer('cached-flights.parquet', bytes);
		return connectionFrom(await db.connect());
	}

	const { queryEngine } =
		mode === 'local'
			? initFjader({ bundles })
			: mode === 'own' && browser
				? initFjader(ownConnection())
				: initFjader();

	let status = $state('Loading…');
	let isLoaded = $state(false);

	onMount(async () => {
		try {
			const source =
				mode === 'own' ? `'cached-flights.parquet'` : `'${location.origin}${parquetUrl}'`;
			await queryEngine.exec(`
				CREATE TABLE flights AS SELECT * FROM read_parquet(${source});
				CREATE VIEW delay_hours AS
					SELECT CAST(LEAST(GREATEST(delay // 60, -1), 6) AS VARCHAR) AS hours_late
					FROM flights WHERE delay IS NOT NULL;
			`);
			const t = await queryEngine.query(
				`SELECT version() AS v, (SELECT count(*) FROM flights)::INT AS n`,
				{ cache: false }
			);
			const row = t.toArray()[0] as { v: string; n: number };
			status = `mode=${mode} · DuckDB ${row.v} · ${row.n.toLocaleString()} rows`;
			isLoaded = true;
		} catch (error) {
			console.error(error);
			status = `mode=${mode} · Error: ${(error as Error).message}`;
		}
	});
</script>

<div class="page">
	<nav>
		<a href="?mode=cdn" data-sveltekit-reload>cdn</a>
		<a href="?mode=local" data-sveltekit-reload>local</a>
		<a href="?mode=own" data-sveltekit-reload>own</a>
	</nav>
	<p class="status">{status}</p>
	{#if isLoaded}
		<div class="chart-wrapper">
			<ChartContainer xLabel="Hours late" yLabel="Flights">
				{#snippet background()}
					<Frame />
					<AxisLeft />
					<AxisBottom />
					<MarginLabel />
				{/snippet}
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<BarMarkY table="delay_hours" x="hours_late" y={count()} />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
			</ChartContainer>
		</div>
	{/if}
</div>

<style>
	.page {
		padding: 1.5rem;
		font-family: system-ui, sans-serif;
	}
	nav {
		display: flex;
		gap: 1rem;
	}
	.status {
		font-family: ui-monospace, monospace;
	}
	.chart-wrapper {
		width: 640px;
		height: 360px;
	}
</style>
