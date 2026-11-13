<script>
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { stackY, topN } from '$lib';
	import { count, sum } from '@uwdata/mosaic-sql';
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
	// The series toggle filters the stacked chart (`selectionResponse="filter"`:
	// an area dims by its own fill field otherwise, which re-queries nothing). Toggled while that chart is
	// off screen, the chart comes back stale: its catch-up result has to be the
	// one fit, not a fit from the old data followed by one from the new.
	const below = page.url.searchParams.get('below') === '1';

	let { queryEngine, gpuCoordinator } = $props();

	// The log: each fit query (by chart; the stacked chart's reads its tooltip
	// table, `_tt_`) and each transition that starts in a chart below the fold,
	// with whether it SNAPPED or SPRANG and whether the chart was on screen. A
	// spring that plays off screen, or two springs to one place, look like
	// nothing happened; the log shows them. On a return, the charts below should
	// snap everything of their own (a catch-up lands without animating).
	let lineEl = $state();
	let stackedEl = $state();
	let barsEl = $state();
	let log = $state([]);
	const t0 = performance.now();

	const named = () => [
		['line', lineEl],
		['stacked', stackedEl],
		['bars', barsEl]
	];

	function onScreen(el) {
		if (!el) return false;
		const r = el.getBoundingClientRect();
		return r.bottom > 0 && r.top < innerHeight;
	}

	function chartNamed(chartId) {
		for (const [name, el] of named()) {
			if (el?.querySelector(`canvas[data-chart-id="${chartId}"]`)) return [name, el];
		}
		return null;
	}

	onMount(() => {
		let nextId = 0;
		const offStatements = queryEngine.observeStatements((rec) => {
			// The probe below re-runs a fit query; skip it.
			if (rec.sql.startsWith('/*probe*/')) return;
			const at = Math.round(rec.start - t0);
			// Tooltip tables are named after the mark id: _tt_area_…, _tt_line_….
			const tt = rec.sql.match(/_tt_(area|line|bar)\w*/);
			if (tt && /^\s*(CREATE|INSERT)/i.test(rec.sql)) {
				const chart = tt[1] === 'area' ? 'stacked' : tt[1] === 'line' ? 'line' : 'bars';
				const el = chart === 'stacked' ? stackedEl : chart === 'line' ? lineEl : barsEl;
				const what = `tooltip table ${/^\s*CREATE/i.test(rec.sql) ? 'create' : 'insert'}`;
				log = [...log, { id: nextId++, at, chart, what, onScreen: onScreen(el) }];
				return;
			}
			if (!/min_y/.test(rec.sql)) return;
			const chart = rec.sql.includes('_tt_area') ? 'stacked' : 'line';
			const el = chart === 'stacked' ? stackedEl : lineEl;
			const id = nextId++;
			log = [...log, { id, at, chart, what: 'fit query', onScreen: onScreen(el) }];
			// What the fit returned: re-read now, so close to what it read.
			queryEngine
				.query('/*probe*/ ' + rec.sql, { cache: false })
				.then((table) => {
					const row = table.get(0) ?? {};
					const vals = (p) =>
						Object.entries(row)
							.filter(([k]) => k.startsWith(p))
							.map(([, v]) => Number(v));
					const range = `[${Math.min(...vals('min_')).toFixed(1)}, ${Math.max(...vals('max_')).toFixed(1)}]`;
					log = log.map((e) => (e.id === id ? { ...e, what: `fit query ${range}` } : e));
				})
				.catch((e) => {
					log = log.map((x) =>
						x.id === id ? { ...x, what: `fit query (probe failed: ${e.message})` } : x
					);
				});
		});
		const offTransitions = gpuCoordinator.observeTransitions((rec) => {
			for (const chartId of rec.charts) {
				const hit = chartNamed(chartId);
				if (!hit) continue;
				const [chart, el] = hit;
				log = [
					...log,
					{
						id: nextId++,
						at: Math.round(rec.time - t0),
						chart,
						what: `${rec.part} ${rec.snap ? 'snap' : 'SPRING'}`,
						spring: !rec.snap,
						onScreen: onScreen(el)
					}
				];
			}
		});
		return () => {
			offStatements();
			offTransitions();
		};
	});
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
							selectionResponse="filter"
							transforms={[stackY({ engine: 'js' })]}
							fitDomain="y"
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
		</ChartContainer>
	</div>
{/snippet}

{#snippet bars()}
	<!-- Sorted bars, filtered by the toggle: its catch-up has morphs and reorders -->
	<div class="bars-wrapper" bind:this={barsEl}>
		<ChartContainer xLabel="bucket" yLabel="sum |y|">
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<BarMarkY
							table="timeseries_split"
							x="bucket"
							y={sum('y')}
							fill="#4c78a8"
							selection="series"
							sort={{ x: 'y', order: 'desc' }}
							transforms={[topN(5, { includeOthers: true })]}
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
		</ChartContainer>
	</div>
{/snippet}

{#snippet bucketPicker()}
	<!-- Same group as the bars: a bucket inside Other splits the Other bar, with
	     no query. On screen, that split slides (a click is a change you made). -->
	<div class="toggle-wrapper">
		<ChartContainer xLabel="bucket (click one in Other)" yLabel="rows">
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<BarMarkY
							table="timeseries_split"
							x="bucket"
							y={count()}
							fill="#999"
							selection="series"
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet interactors()}
				<Toggle selection="series" field="bucket" />
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
	<!-- Filters the charts below; click a bar to toggle its series -->
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
			Fits and transitions <button onclick={() => (log = [])}>Clear</button>
		</header>
		{#each log as f (f.id)}
			<div class:spring={f.spring}>
				{f.at} ms · {f.chart} · {f.what} · {f.onScreen ? 'on screen' : 'off screen'}
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
			The fitted charts and a sorted bar chart are below the fold, with a second overview just above
			them; the log (top right) lists each fit query and each transition in them, snap or SPRING. A
			return to view snaps; a brush you make while they are on screen springs. (1) Brush here,
			scroll down: one fit per fitted chart, snapped. (2) Brush and toggle a series here, scroll
			down: one stacked fit, from the toggled data; the bars' morph and reorder snap. (3) Below,
			zoom the stacked chart's y axis; scroll up, toggle, scroll back; then brush the lower
			overview: that fit SPRINGS. (4) Reload, toggle at once, scroll down: the bars enter, with no
			morph on top. (5) Brush the lower overview: fits SPRING. (6) Toggle series b here, scroll down
			(the bars catch up, snapped), then click a bucket in the picker below the bars that sits
			inside their Other bar: the split slides, a bars morph SPRING.
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
			{@render overview()}
			{@render detail()}
			{@render stacked()}
			{@render bars()}
			{@render bucketPicker()}
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

	.fit-log .spring {
		color: #b45309;
	}

	.fit-log .empty {
		color: #999;
	}

	.bars-wrapper {
		width: 100%;
		height: 260px;
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
