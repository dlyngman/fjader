<script>
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';

	import { setQueryContext, initDuckDB } from '$lib/query-engine';
	setCoordinators();

	const { queryEngine } = setQueryContext(initDuckDB());

	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			// Load penguins dataset for the brush demo
			await queryEngine.exec([loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString()]);

			isLoaded = true;
		} catch (error) {
			console.error('Failed to initialize:', error);
			loadError = error.message;
		}
	});
</script>

{#if loadError}
	<div style="padding: 2rem; color: red;">
		<h2>Error loading data</h2>
		<p>{loadError}</p>
	</div>
{:else if isLoaded}
	<MainView />
{:else}
	<div style="padding: 2rem;">Loading DuckDB and penguins dataset...</div>
{/if}
