<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import MainView from './MainView.svelte';

	import { setQueryContext } from '$lib/query-engine';
	setCoordinators();

	const wasm = wasmConnector();
	const coord = new Coordinator();
	coord.databaseConnector(wasm);
	setContext('mosaic-coordinator', coord);
	let resolveConn;
	setQueryContext(new Promise((r) => { resolveConn = r; }));
	let isLoaded = $state(false);

	onMount(async () => {
		resolveConn(await wasm.getConnection());
		await coord.exec(loadParquet('flights', `${window.location.origin}/data/flights-200k.parquet`));
		isLoaded = true;
	});
</script>

{#if isLoaded}
	<MainView />
{:else}
	<p style="padding: 2rem;">Loading...</p>
{/if}
