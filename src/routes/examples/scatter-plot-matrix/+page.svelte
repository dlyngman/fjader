<script>
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import MainView from './MainView.svelte';


	const { queryEngine } = initFjader();

	let isLoaded = $state(false);
	let loadError = $state(null);

	const logs = [];
	const queryLogger = {
		...console,

		debug(...values) {
			if (values.length > 0 && typeof values[0] === 'string' && values[0].includes('Query')) {
				const queryLog = values[1];

				if (queryLog && queryLog.sql) {
					const timestamp = new Date().toLocaleTimeString('sv-SE', { hour12: false });
					console.log(`[${timestamp}] \n${queryLog.sql}`);
					logs.push({ query: queryLog.sql, time: new Date() });
				}
			}
		},
		getLogs() {
			return logs;
		}
	};

	let frameTimes = [];
	let lastVsync = 0;

	function measureRAF(time) {
		if (lastVsync > 0) {
			const delta = time - lastVsync;
			frameTimes.push(delta);

			// Detect stutters in real-time
			if (delta > 12) {
				console.warn(`RAF gap: ${delta.toFixed(1)}ms at ${time.toFixed(0)}`);
			}
		}
		lastVsync = time;

		if (frameTimes.length === 500) {
			// Analyze distribution
			const sorted = [...frameTimes].sort((a, b) => a - b);
			console.log('RAF timing analysis:');
			console.log(`  Min: ${sorted[0].toFixed(2)}ms`);
			console.log(`  Max: ${sorted[sorted.length - 1].toFixed(2)}ms`);
			console.log(`  Median: ${sorted[250].toFixed(2)}ms`);
			console.log(`  p95: ${sorted[475].toFixed(2)}ms`);
			console.log(`  p99: ${sorted[495].toFixed(2)}ms`);
			console.log(`  Stutters (>12ms): ${frameTimes.filter((t) => t > 12).length}`);

			// Show histogram
			const buckets = {};
			frameTimes.forEach((t) => {
				const bucket = Math.floor(t / 2) * 2;
				buckets[bucket] = (buckets[bucket] || 0) + 1;
			});
			console.log('  Distribution:', buckets);

			frameTimes = [];
		}

		requestAnimationFrame(measureRAF);
	}

	onMount(async () => {
		try {
			await queryEngine.exec([loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString()]);

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
