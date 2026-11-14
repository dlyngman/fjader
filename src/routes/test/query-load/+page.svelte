<script>
	/**
	 * Phase 0 load measurement (proposal_query_scheduling.md): twelve charts on
	 * 200k flights, two per row, so only the top rows are on screen.
	 *
	 *   ?mount=all  every chart mounts (default)
	 *   ?mount=visible  the first eight, the ones on screen in a typical window
	 *   ?mount=top  only the first four
	 *   ?slow=1  adds dots on a slow view, filtered by the brush
	 *   ?share=N  the lanes' slice share: one slice per N ms (default 10)
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

	// ?share=N: the lanes' slice share, one slice per N ms (QueryEngineOptions
	// .sliceShareMs), for measuring it.
	const shareParam = Number(page.url.searchParams.get('share'));
	const sliceShareMs = shareParam > 0 ? shareParam : undefined;
	const { queryEngine, gpuCoordinator } = initFjader({ engine: { sliceShareMs } });
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
	// ?tooltipSort=on: the scatters' tooltip tables written with ORDER BY (the
	// default is unsorted), to compare write and hover lookup times.
	const tooltipSort = page.url.searchParams.get('tooltipSort');
	const tooltip =
		tooltipSort === 'on'
			? { sortTable: true }
			: tooltipSort === 'off'
				? { sortTable: false }
				: true;
	// ?scale=10: the flights table times ten (2M rows), each copy jittered, to
	// measure on data the size users have.
	const scale = Math.max(1, Number(page.url.searchParams.get('scale') ?? 1) || 1);
	let isLoaded = $state(false);

	/**
	 * A drag that is the same on every run, for comparing branches: real pointer
	 * events on chart 1, through the chart's own hit test and the brush's code.
	 * Enters the chart, waits 1.5 s so the hover's preagg builds are done (the
	 * steady state), then sweeps the brush's far edge from 20% to 80% of the
	 * plot and back over 2 s, one move per frame. Recorded in the log as
	 * `drag: { start, end }`.
	 *
	 * Pointer id 1 is the mouse, always an active pointer, so the brush's
	 * setPointerCapture succeeds (a failure would start no drag, and the log
	 * would show no brush queries). That capture is real: the REAL mouse's moves
	 * also go to chart 1 until the script's pointerup, so don't move the mouse
	 * during a run. Both pointermove and pointerrawupdate are fired; ChartCell
	 * handles exactly one of them (rawupdate where the browser has it, outside
	 * an iframe), so the brush gets one move per frame either way.
	 */
	let drag = null;
	let dragging = $state(false);
	async function scriptedDrag() {
		const svg = document.querySelector('[data-chart^="1 "] svg.svg-foreground');
		if (!svg) return;
		dragging = true;
		const r = svg.getBoundingClientRect();
		const y = r.top + r.height * 0.5;
		const at = (f) => r.left + r.width * f;
		const fire = (type, x) =>
			svg.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					composed: true,
					pointerId: 1,
					pointerType: 'mouse',
					isPrimary: true,
					button: 0,
					buttons: type === 'pointerup' ? 0 : 1,
					clientX: x,
					clientY: y
				})
			);
		const frame = () => new Promise((res) => requestAnimationFrame(res));
		fire('pointerenter', at(0.2));
		svg
			.closest('.chart-cell')
			?.dispatchEvent(new PointerEvent('pointerenter', { clientX: at(0.2), clientY: y }));
		await new Promise((res) => setTimeout(res, 1500));
		const start = performance.now();
		fire('pointerdown', at(0.2));
		const ms = 2000;
		for (;;) {
			await frame();
			const t = (performance.now() - start) / ms;
			if (t >= 1) break;
			const f = 0.2 + 0.6 * (t < 0.5 ? t * 2 : 2 - t * 2);
			fire('pointermove', at(f));
			fire('pointerrawupdate', at(f));
		}
		fire('pointerup', at(0.2));
		drag = { start, end: performance.now() };
		dragging = false;
	}

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
	// ?slow=1: dots on a slow view of flights, filtered by the same brush,
	// second on the page so it is on screen. Its every read pays an
	// uncorrelated subquery (~100-200 ms), so it reads on a lane; the others
	// stay on the main connection. Dots, not a histogram: an aggregate gets a
	// preagg table on hover and its brush reads stop touching the view (a
	// histogram here read a 79 ms build, then 8.7 ms per update). A raw-row
	// read hits the view on every update, which is what checks the hold's
	// cap: the fast charts keep their pace and the slow one still updates.
	const slow = page.url.searchParams.get('slow') === '1';
	if (slow) {
		charts.splice(1, 0, {
			name: '1b delay by distance (slow view, dots)',
			kind: 'dots',
			x: 'distance',
			y: 'delay',
			table: 'slow_flights'
		});
	}
	const shown =
		mount === 'top' ? charts.slice(0, 4) : mount === 'visible' ? charts.slice(0, 8) : charts;

	onMount(async () => {
		await queryEngine.exec(
			msql.loadParquet('flights', `${location.origin}/data/flights-200k.parquet`).toString()
		);
		if (scale > 1) {
			await queryEngine.exec(`
				CREATE OR REPLACE TABLE flights AS
				SELECT
					(delay + CASE WHEN k = 0 THEN 0 ELSE round((random() - 0.5) * 6) END)::SMALLINT AS delay,
					(distance + CASE WHEN k = 0 THEN 0 ELSE round((random() - 0.5) * 20) END)::SMALLINT AS distance,
					(time + CASE WHEN k = 0 THEN 0 ELSE (random() - 0.5) * 0.2 END)::FLOAT AS time
				FROM flights, range(${scale}) r(k)
			`);
		}
		if (slow) {
			await queryEngine.exec(`
				CREATE OR REPLACE VIEW slow_flights AS
				SELECT * FROM flights
				WHERE (SELECT 0 * avg(hash(i) % 1000) FROM range(5000000) t(i)) = 0
			`);
		}
		mountedAt = performance.now();
		isLoaded = true;
	});
</script>

<div class="page">
	<p class="note">
		mount={mount}: {shown.length} charts, {scale * 200}k rows. Brush chart 1.
		<button onclick={report}>Report (console)</button>
		<button
			onclick={() =>
				log.download(
					`qlog-${mount}${scale > 1 ? `-x${scale}` : ''}${slow ? '-slow' : ''}${sliceShareMs ? `-share${sliceShareMs}` : ''}${tooltipSort ? `-sort-${tooltipSort}` : ''}.json`,
					{
						mountedAt,
						entrances,
						hovers,
						drag
					}
				)}
		>
			Save log
		</button>
		<button disabled={!isLoaded || dragging} onclick={scriptedDrag}>
			{dragging ? 'dragging…' : 'Scripted drag'}
		</button>
		{#if dragging}<span>don't move the mouse</span>{/if}
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
												table={chart.table ?? 'flights'}
												x={bin(chart.x, chart.steps ? { steps: chart.steps } : {})}
												y={count()}
												selection="brush"
											/>
										{:else if chart.kind === 'dots'}
											<DotsMark
												table={chart.table ?? 'flights'}
												x={chart.x}
												y={chart.y}
												r={1}
												opacity={0.3}
												selection="brush"
												{tooltip}
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
