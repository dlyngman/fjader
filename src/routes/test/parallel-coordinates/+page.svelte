<script>
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { setQueryContext, initDuckDB } from '$lib/query-engine';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';

	setCoordinators();

	const { queryEngine } = setQueryContext(initDuckDB());

	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec(loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString());
			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<div class="app-container">
	{#if loadError}
		<div class="error-container">Error: {loadError}</div>
	{:else if !isLoaded}
		<div class="loading-container">Loading penguins dataset...</div>
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

	.loading-container,
	.error-container {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 200px;
		padding: 2rem;
	}
</style>
