<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import MainView from './MainView.svelte';

	setCoordinators();

	let coord;
	let isLoaded = $state(false);

	onMount(async () => {
		const wasm = wasmConnector();
		coord = new Coordinator();
		coord.databaseConnector(wasm);
		setContext('mosaic-coordinator', coord);
		await coord.exec(
			loadParquet('flights', `${window.location.origin}/data/flights-200k.parquet`)
		);
		isLoaded = true;
	});
</script>

{#if isLoaded}
	<MainView />
{:else}
	<p style="padding: 2rem;">Loading...</p>
{/if}
