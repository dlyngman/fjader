<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { loadParquet } from '@uwdata/mosaic-sql';
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

	onMount(async () => {
			const connection = await wasm.getConnection();
			queryEngine = new QueryEngine(connection);
		await coord.exec(loadParquet('flights', `${window.location.origin}/data/flights-200k.parquet`));
		isLoaded = true;
	});
</script>

{#if isLoaded && queryEngine}
	<QueryEngineProvider {queryEngine}>
		<MainView />
	</QueryEngineProvider>
{:else}
	<p style="padding: 2rem;">Loading...</p>
{/if}
