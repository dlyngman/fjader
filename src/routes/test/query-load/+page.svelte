<script>
	/**
	 * Phase 0 load measurement (proposal_query_scheduling.md): twelve charts on
	 * 200k flights, two per row, so only the top rows are on screen.
	 *
	 *   ?mount=all  every chart mounts (default)
	 *   ?mount=visible  the first eight, the ones on screen in a typical window
	 *   ?mount=top  only the first four
	 *
	 * The difference in when the top charts enter is the most query
	 * prioritization could win at load. Every chart shares the "brush"
	 * selection; brushing the first one during or after load measures how long
	 * the re-queries wait. "Save log" downloads every statement the engine sent
	 * (attachQueryLog), with the mount time, for analysis.
	 */
	import * as msql from '@uwdata/mosaic-sql';
	import { count, avg } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		WebGPUCanvas,
		RectYMark,
		DotsMark,
		AreaMarkY,
		LineMark,
		IntervalX
	} from '$lib/components';
	import { bin } from '$lib/sql/bin';
	import { attachQueryLog } from '$lib/query-engine/debug/query-log';

	const { queryEngine, gpuCoordinator } = initFjader();
	const log = attachQueryLog(queryEngine);
	let mountedAt = 0;
	/** When each chart's entrance started, labelled by its section: { chart, time }. */
	const entrances = [];
	/** Pointer entering a chart's section: { chart, time }, to time hover-intent work. */
	const hovers = [];
	gpuCoordinator.observeEntrances(({ canvas, chartId, time }) => {
		const label = canvas.closest('[data-chart]')?.dataset.chart;
		entrances.push({ chart: label ?? chartId, time });
	});
	function report() {
		log.report();
		console.log('[query-load] entrances, ms after the charts mounted:');
		console.table(entrances.map((e) => ({ chart: e.chart, ms: +(e.time - mountedAt).toFixed(0) })));
	}
	const mount = page.url.searchParams.get('mount') ?? 'all';
	let isLoaded = $state(false);

	const charts = [
		{ name: '1 delay histogram (brush)', kind: 'hist', x: 'delay', brush: true },
		{ name: '2 distance histogram', kind: 'hist', x: 'distance' },
		{ name: '3 time histogram', kind: 'hist', x: 'time' },
		{ name: '4 delay by distance (200k dots)', kind: 'dots', x: 'distance', y: 'delay' },
		{ name: '5 delay by time (200k dots)', kind: 'dots', x: 'time', y: 'delay' },
		{ name: '6 flights over time (area)', kind: 'area', x: 'time' },
		{ name: '7 mean delay over distance (line)', kind: 'line', x: 'distance', y: 'delay' },
		{ name: '8 mean distance over time (line)', kind: 'line', x: 'time', y: 'distance' },
		{ name: '9 distance by time (200k dots)', kind: 'dots', x: 'time', y: 'distance' },
		{ name: '10 delay histogram, fine', kind: 'hist', x: 'delay', steps: 200 },
		{ name: '11 distance over delay (area)', kind: 'area', x: 'delay' },
		{ name: '12 mean delay over time (line)', kind: 'line', x: 'time', y: 'delay' }
	];
	const shown =
		mount === 'top' ? charts.slice(0, 4) : mount === 'visible' ? charts.slice(0, 8) : charts;

	onMount(async () => {
		await queryEngine.exec(
			msql.loadParquet('flights', `${location.origin}/data/flights-200k.parquet`).toString()
		);
		mountedAt = performance.now();
		isLoaded = true;
	});
</script>

<div class="page">
	<p class="note">
		mount={mount}: {shown.length} charts. Brush chart 1.
		<button onclick={report}>Report (console)</button>
		<button onclick={() => log.download(`qlog-${mount}.json`, { mountedAt, entrances, hovers })}>
			Save log
		</button>
	</p>
	{#if isLoaded}
		<div class="grid">
			{#each shown as chart (chart.name)}
				<section
					data-chart={chart.name}
					onpointerenter={() => hovers.push({ chart: chart.name, time: performance.now() })}
				>
					<h2>{chart.name}</h2>
					<div class="chart">
						<ChartContainer xLabel={chart.x} yLabel={chart.y ?? 'count'}>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										{#if chart.kind === 'hist'}
											<RectYMark
												table="flights"
												x={bin(chart.x, chart.steps ? { steps: chart.steps } : {})}
												y={count()}
												selection="brush"
											/>
										{:else if chart.kind === 'dots'}
											<DotsMark
												table="flights"
												x={chart.x}
												y={chart.y}
												r={1}
												opacity={0.3}
												selection="brush"
											/>
										{:else if chart.kind === 'area'}
											<AreaMarkY
												table="flights"
												x={bin(chart.x)}
												y={count()}
												fillOpacity={0.6}
												selection="brush"
											/>
										{:else}
											<LineMark
												table="flights"
												x={bin(chart.x)}
												y={avg(chart.y)}
												selection="brush"
											/>
										{/if}
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
							{#snippet interactors()}
								{#if chart.brush}<IntervalX selection="brush" />{/if}
							{/snippet}
						</ChartContainer>
					</div>
				</section>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page {
		padding: 1rem;
		font-family: system-ui, sans-serif;
	}
	.note {
		color: #666;
		font-size: 0.85rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, 560px);
		gap: 1rem;
	}
	.chart {
		width: 100%;
		height: 300px;
	}
	h2 {
		font-size: 0.9rem;
		font-weight: 500;
		margin: 0.25rem 0;
	}
</style>
