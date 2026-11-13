<script>
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { stackY } from '$lib';
	import { count } from '@uwdata/mosaic-sql';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import {
		ChartContainer,
		Grid,
		Crosshair,
		WebGPUCanvas,
		LineMark,
		AreaMarkY,
		BarMarkY,
		IntervalX
	} from '$lib/components';

	// ?below=1: the overview goes on top and the fitted charts below a spacer, so
	// they are off screen (past the visibility observer's 200 px margin) while the
	// overview is brushed. Scrolling down then checks that each fits once to the
	// zoomed x range on its return: the line through the plain refit, the stacked
	// areas (a JS stack) through the tooltip table their fit reads.
	//
	// The series toggle filters the stacked chart. Toggled while that chart is
	// off screen, the chart comes back stale: its catch-up result has to be the
	// one fit, not a fit from the old data followed by one from the new.
	const below = page.url.searchParams.get('below') === '1';

	let { queryEngine } = $props();

	// Each fitDomain query, by chart, and whether that chart was on screen when
	// it settled. A fit sent while the chart is still inside the observer's
	// margin plays its spring off screen; two fits to one extent look like one.
	// The stacked chart's fit reads its tooltip table (`_tt_`), the line's wraps
	// its own query.
	let lineEl = $state();
	let stackedEl = $state();
	let fits = $state([]);
	const t0 = performance.now();

	function onScreen(el) {
		if (!el) return false;
		const r = el.getBoundingClientRect();
		return r.bottom > 0 && r.top < innerHeight;
	}

	onMount(() =>
		queryEngine.observeStatements((rec) => {
			if (!/min_y/.test(rec.sql)) return;
			const chart = rec.sql.includes('_tt_') ? 'stacked' : 'line';
			const el = chart === 'stacked' ? stackedEl : lineEl;
			fits = [
				...fits,
				{ chart, at: Math.round(rec.start - t0), ms: rec.end - rec.start, onScreen: onScreen(el) }
			];
		})
	);
</script>

{#snippet detail()}
	<!-- Detail chart: domain follows overview brush -->
	<div class="detail-wrapper" bind:this={lineEl}>
		<ChartContainer xLabel="x" yLabel="y" useXSelection>
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<LineMark table="timeseries" x="x" y="y" strokeWidth={1.5} fitDomain="y" />
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet foreground()}
				<Crosshair />
			{/snippet}
		</ChartContainer>
	</div>
{/snippet}

{#snippet stacked()}
	<!-- Stacked detail: a JS stack, so its fit reads the tooltip table -->
	<div class="detail-wrapper" bind:this={stackedEl}>
		<ChartContainer xLabel="x" yLabel="|y|, stacked" useXSelection>
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<AreaMarkY
							table="timeseries_split"
							x="x"
							y="y"
							fill="series"
							selection="series"
							transforms={[stackY({ engine: 'js' })]}
							fitDomain="y"
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
		</ChartContainer>
	</div>
{/snippet}

{#snippet overview()}
	<!-- Overview chart: full range, brushable -->
	<div class="overview-wrapper">
		<ChartContainer xLabel="x" yLabel="y" margin={{ top: 10, right: 50, bottom: 25, left: 75 }}>
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<LineMark table="timeseries" x="x" y="y" strokeWidth={1} />
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet interactors()}
				<IntervalX />
			{/snippet}
		</ChartContainer>
	</div>
{/snippet}

{#snippet seriesToggle()}
	<!-- Filters the stacked chart; click a bar to toggle its series -->
	<div class="toggle-wrapper">
		<ChartContainer xLabel="series" yLabel="rows">
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<BarMarkY
							table="timeseries_split"
							x="series"
							y={count()}
							fill="series"
							selection="series"
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet interactors()}
				<Toggle selection="series" field="series" />
			{/snippet}
		</ChartContainer>
	</div>
{/snippet}

{#if below}
	<aside class="fit-log">
		<header>
			Fit queries <button onclick={() => (fits = [])}>Clear</button>
		</header>
		{#each fits as f, i (i)}
			<div class:off={!f.onScreen}>
				{f.at} ms · {f.chart} · {f.onScreen ? 'on screen' : 'OFF SCREEN'}
			</div>
		{:else}
			<div class="empty">none yet</div>
		{/each}
	</aside>
{/if}

<div class="main-view-container">
	<h2>Overview + Detail (Brush-Linked Domain)</h2>
	{#if below}
		<p>
			The fitted charts are below the fold. Scroll down once so they load, back up, brush the
			overview (or move the brush), then scroll down: each y axis should fit once to the brushed
			range, with no second animation. To come back stale, also toggle a series before scrolling
			down: still one stacked fit, from the toggled data.
			<a href="?">Default layout</a>
		</p>
	{:else}
		<p>
			Drag a brush on the overview to zoom the detail chart. Pan/zoom the detail and the brush
			tracks. <a href="?below=1">Fitted charts below the fold</a>
		</p>
	{/if}

	<div class="charts-stack">
		{#if below}
			{@render overview()}
			{@render seriesToggle()}
			<div class="spacer">Fitted charts below ↓</div>
			{@render detail()}
			{@render stacked()}
		{:else}
			{@render detail()}
			{@render overview()}
		{/if}
	</div>
</div>

<style>
	.main-view-container {
		width: 100%;
		max-width: 1000px;
		margin: 0 auto;
		padding: 20px;
	}

	h2 {
		margin-bottom: 4px;
	}

	p {
		margin-bottom: 16px;
		color: #666;
		font-size: 14px;
	}

	.charts-stack {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.detail-wrapper {
		width: 100%;
		height: 400px;
	}

	.overview-wrapper {
		width: 100%;
		height: 120px;
	}

	.fit-log {
		position: fixed;
		top: 12px;
		right: 12px;
		z-index: 10;
		min-width: 240px;
		max-height: 50vh;
		overflow-y: auto;
		padding: 8px 10px;
		background: rgba(255, 255, 255, 0.95);
		border: 1px solid #ddd;
		border-radius: 6px;
		font:
			12px/1.5 ui-monospace,
			monospace;
	}

	.fit-log header {
		display: flex;
		justify-content: space-between;
		margin-bottom: 4px;
		font-weight: 600;
	}

	.fit-log .off {
		color: #b45309;
	}

	.fit-log .empty {
		color: #999;
	}

	.toggle-wrapper {
		width: 320px;
		height: 160px;
	}

	/* Taller than the viewport plus the observer's 200 px margin. */
	.spacer {
		height: calc(100vh + 400px);
		display: flex;
		align-items: flex-end;
		justify-content: center;
		padding-bottom: 16px;
		color: #999;
		font-size: 14px;
	}
</style>
