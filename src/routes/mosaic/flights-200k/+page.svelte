<script>
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';
	import { observeTransitions } from '$lib/animation/transition-log';

	const { queryEngine } = initFjader();
	//
	let isLoaded = $state(false);
	let loadError = $state(null);

	// const logs = [];
	// const queryLogger = {
	// 	...console,

	// 	debug(...values) {
	// 		if (values.length > 0 && typeof values[0] === 'string' && values[0].includes('Query')) {
	// 			const queryLog = values[1];

	// 			if (queryLog && queryLog.sql) {
	// 				const timestamp = new Date().toLocaleTimeString('sv-SE', { hour12: false });
	// 				console.log(`[${timestamp}] \n${queryLog.sql}`);
	// 				logs.push({ query: queryLog.sql, time: new Date() });
	// 			}
	// 		}
	// 	},
	// 	getLogs() {
	// 		return logs;
	// 	}
	// };

	// ?log=1: the histograms' rebin decisions (hold, or forward and why), newest first.
	let rebinLog = $state([]);
	const showLog =
		typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('log');

	onMount(() => {
		if (!showLog) return;
		const t0 = performance.now();
		return observeTransitions((rec) => {
			if (rec.part !== 'rebin') return;
			const t = Math.round(rec.time - t0);
			rebinLog = [{ t, label: rec.label.split('-')[0], detail: rec.detail }, ...rebinLog].slice(
				0,
				40
			);
		});
	});

	onMount(async () => {
		try {
			await queryEngine.exec(
				loadParquet('flights', `${window.location.origin}/data/flights-200k.parquet`).toString()
			);

			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<div class="app-container">
	{#if loadError}
		<div class="error-container">Error loading data: {loadError}</div>
	{:else if !isLoaded}
		<div class="loading-container">Loading parquet data...</div>
	{:else}
		<MainView />
	{/if}
	{#if showLog}
		<ol class="rebin-log">
			{#each rebinLog as entry (entry)}
				<li>{entry.t} ms · {entry.label} · {entry.detail}</li>
			{/each}
		</ol>
	{/if}
</div>

<style>
	.app-container {
		width: 100%;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.rebin-log {
		position: fixed;
		right: 8px;
		bottom: 8px;
		max-height: 40vh;
		overflow: auto;
		margin: 0;
		padding: 6px 10px 6px 28px;
		font:
			11px/1.4 ui-monospace,
			monospace;
		background: rgb(255 255 255 / 0.92);
		border: 1px solid #ccc;
		border-radius: 4px;
		pointer-events: auto;
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
