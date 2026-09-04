<script>
	import { initDivePlot } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';

	const { queryEngine } = initDivePlot();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			// 1M web request events: 30 days × 5 regions, with continuous payload_size for brushing.
			// Each (date, region, payload_bin) cell holds ~26 events on average, so the preagg
			// table collapses 1M source rows down to ~38k rows. That collapse is what
			// makes window CTE preagg meaningfully faster than scanning the base table.
			await queryEngine.exec(`
				CREATE TABLE web_events AS
				SELECT
					DATE '2024-01-01' + INTERVAL (idx % 30) DAY as date,
					['us-east', 'us-west', 'eu', 'asia', 'oceania'][1 + (idx % 5)] as region,
					-- response_time: slow drift over the dataset + per-event noise (50ms-500ms)
					80 + 200 * (sin(idx * 0.0000003) + 1) / 2 + 60 * random() as response_time,
					-- payload_size: continuous 1KB-10KB, uniform distribution
					1000 + 9000 * random() as payload_size
				FROM range(1000000) AS t(idx)
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
		<div class="status">Generating 1M web events...</div>
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
	.status {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 200px;
		padding: 2rem;
	}
</style>
