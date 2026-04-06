<script>
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';


	const { queryEngine } = initDivePlot();
	let isLoaded = $state(false);

	onMount(async () => {
		await queryEngine.exec(loadParquet('flights', `${window.location.origin}/data/flights-200k.parquet`).toString());
		isLoaded = true;
	});
</script>

{#if isLoaded}
	<MainView />
{:else}
	<p style="padding: 2rem;">Loading...</p>
{/if}
