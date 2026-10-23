<script>
	/**
	 * Scale source parity: every chart below drawn by this build and compared,
	 * pixel for pixel, with the same charts drawn by the previous one.
	 *
	 * Why pixels. The failure this guards against is a wrong scale reaching a
	 * shader — a chart drawing through another chart's params, or an axis
	 * through another axis's — and that renders plausible, wrong pixels rather
	 * than an error. Unit tests reach neither the pass that pushes the params
	 * nor the shader that reads them, so the only honest check is the one that
	 * looks.
	 *
	 * How. Record a baseline on the commit before a change; it lives in
	 * IndexedDB. Compare on the commit after: every canvas must match. Each
	 * draw remounts the charts and waits for two identical captures in a row,
	 * and Record also refuses a baseline that two remounts drew differently.
	 *
	 * Readback goes through the coordinator, which copies each canvas texture in
	 * the frame that draws it. `createImageBitmap` on the element saw every
	 * chart as transparent while all of them were on screen: a WebGPU canvas's
	 * texture expires once presented.
	 *
	 * The controls. A comparison that cannot see a wrong scale proves nothing,
	 * so the charts whose scales arrive by a path of their own each have a
	 * test-only switch that sends a wrong one, named by `data-control`, and
	 * Compare requires it to change that chart: `m4Parity.swapScale` bins the
	 * decimating line by its y scale, and `parallelParity.reverseScales` hands
	 * each parallel axis another axis's scale.
	 */
	import { onMount, tick } from 'svelte';
	import { loadParquet, count } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import { m4Parity } from '$lib/gpu/decimation/M4Decimator.svelte';
	import { parallelParity } from '$lib/components/marks/ParallelCoordinatesMark.svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		WebGPUCanvas,
		BarMarkX,
		BarMarkY,
		DotsMark,
		LineMark,
		AreaMarkY,
		ParallelAxes,
		ParallelCoordinatesMark
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';

	const { queryEngine, gpuCoordinator } = initDivePlot();
	// Before any chart mounts: a canvas reads it when it configures its context.
	gpuCoordinator.readbackEnabled = true;

	let loaded = $state(false);
	let loadError = $state(null);
	/** Bumped to remount every chart, so each draw starts from nothing. */
	let generation = $state(0);
	let running = $state(false);
	let status = $state('');
	let verdict = $state(null);
	/** One row per canvas for the baseline comparison. */
	let baselineRows = $state([]);
	/** When the stored baseline was recorded, and of how many canvases. */
	let baselineInfo = $state(null);
	/** Where two captures of a chart disagree, for every mismatch the last action found. */
	let diffs = $state([]);

	/** @type {HTMLElement | undefined} */
	let chartsEl = $state();

	onMount(async () => {
		try {
			await queryEngine.exec([
				loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString()
			]);
			// Deterministic: a remount re-queries, and a random() here would make
			// every source differ from every other for reasons of its own.
			//
			// `step`, not `x`: scales are shared by field name, and parity_dense's
			// `x` runs to 66,666, which squeezed these 200 points into the first
			// pixel column of every chart that drew them.
			await queryEngine.exec([
				`CREATE OR REPLACE TABLE parity_series AS
				WITH RECURSIVE points AS (
					SELECT 0 AS idx UNION ALL SELECT idx + 1 FROM points WHERE idx < 199
				)
				SELECT
					idx AS step,
					POWER(10, idx * 4.0 / 199) AS grows,
					(idx - 100) * ABS(idx - 100) AS signed,
					2.0 + sin(idx * 0.08) AS wave
				FROM points`
			]);
			// Dense enough that M4 has real work: three series of 66,667 points on a
			// chart a few hundred pixels wide. The fast wobble puts a spread of y in
			// every pixel column, so which points a bin keeps is visible.
			await queryEngine.exec([
				`CREATE OR REPLACE TABLE parity_dense AS
				SELECT
					i AS x,
					's' || s AS series,
					s * 3 + sin(i * 0.002 + s) + 0.3 * sin(i * 0.37) AS y
				FROM range(66667) t(i), range(3) u(s)`
			]);
			baselineInfo = await loadBaselineInfo();
			loaded = true;
		} catch (error) {
			console.error(error);
			loadError = String(error?.message ?? error);
		}
	});

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	/**
	 * Every chart canvas, in document order, with the section it belongs to and
	 * the control it answers to (`chart`, meaning none, unless the section
	 * names its own).
	 */
	function canvases() {
		return [...(chartsEl?.querySelectorAll('canvas') ?? [])].map((canvas) => {
			const section = canvas.closest('[data-chart]');
			return {
				canvas,
				chart: section?.getAttribute('data-chart') ?? '?',
				control: section?.getAttribute('data-control') ?? 'chart'
			};
		});
	}

	/** One frame of every canvas in `list`, in order; null for one that did not render. */
	async function captureAll(list) {
		const captures = await gpuCoordinator.captureCharts();
		return list.map(({ canvas }) => captures.get(canvas) ?? null);
	}

	function differing(a, b) {
		if (!a || !b || a.length !== b.length) return Infinity;
		let n = 0;
		for (let i = 0; i < a.length; i += 4) {
			if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3])
				n++;
		}
		return n;
	}

	function blank(pixels) {
		if (!pixels) return true;
		for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) return false;
		return true;
	}

	/**
	 * Remount everything and read it back once it has settled:
	 * two captures 300ms apart that agree, pixel for pixel. Data loads and
	 * scale springs both finish on their own time, and a fixed wait would
	 * compare a frame mid-animation against a frame at rest.
	 *
	 * A correct build must draw something on every canvas before it counts as
	 * settled. The control is allowed to be blank — a wrong scale usually puts
	 * every mark off the canvas, which is the point of it — but blank is also
	 * what a chart looks like before its data arrives, and nothing the page can
	 * see tells the two apart. So a blank control is accepted only after
	 * `minMs`, the time the correct draw needed for the same charts.
	 */
	async function draw({
		label = 'this build',
		allowBlank = false,
		minMs = 0,
		m4Swap = false,
		parallelReverse = false
	} = {}) {
		m4Parity.swapScale = m4Swap;
		parallelParity.reverseScales = parallelReverse;
		generation++;
		await tick();
		status = `drawing ${label}…`;
		const start = performance.now();
		let previous = null;
		let list = [];
		let captures = [];
		for (let attempt = 0; attempt < 40; attempt++) {
			await sleep(300);
			list = canvases();
			captures = await captureAll(list);
			const shots = captures.map((c) => c?.pixels ?? null);
			// Blank is not settled: right after a remount the pipelines are still
			// compiling and the data is still in flight, and two blank captures
			// agree with each other perfectly.
			const drawn =
				shots.length > 0 &&
				captures.every((c) => c?.drew) &&
				(allowBlank ? performance.now() - start >= minMs : shots.every((s) => !blank(s)));
			const settled =
				drawn &&
				previous &&
				previous.length === shots.length &&
				shots.every((s, i) => differing(s, previous[i]) === 0);
			if (settled) return { shots, ms: performance.now() - start };
			previous = shots;
		}
		// Why the last capture was not usable, per chart, most basic cause first.
		const names = (keep) => list.filter((_, i) => keep(captures[i])).map(({ chart }) => chart);
		const absent = names((c) => !c);
		const noDraws = names((c) => c && !c.drew);
		const blankDrawn = names((c) => c && c.drew && blank(c.pixels));
		const of = `of ${list.length} canvases`;
		if (absent.length)
			throw new Error(`${label}: ${absent.length} ${of} never rendered: ${absent.join(', ')}.`);
		if (noDraws.length)
			throw new Error(
				`${label}: ${noDraws.length} ${of} rendered but issued no draws: ${noDraws.join(', ')}.`
			);
		if (blankDrawn.length)
			throw new Error(
				`${label}: ${blankDrawn.length} ${of} issued draws but stayed blank: ${blankDrawn.join(', ')}. Either the marks land off the canvas or their data never arrived.`
			);
		throw new Error(`${label} never settled: captures kept changing for 12s.`);
	}

	/**
	 * Picture where `a` and `b` disagree on each chart named in `which`: `a`
	 * dimmed, red where only `a` has ink, blue where only `b` does, purple where
	 * both do but differently. Plus the box the differences fall in — whether
	 * the whole mark moved or one end of it did is most of a diagnosis.
	 */
	function showDiffs(labels, a, b, list, which) {
		diffs = list.flatMap(({ canvas, chart }, i) => {
			if (!which.includes(chart) || !a[i] || !b[i] || a[i].length !== b[i].length) return [];
			const { width, height } = canvas;
			const img = new ImageData(width, height);
			const out = img.data;
			let n = 0;
			let x0 = width;
			let y0 = height;
			let x1 = -1;
			let y1 = -1;
			for (let p = 0; p < a[i].length; p += 4) {
				const pa = a[i];
				const pb = b[i];
				const same =
					pa[p] === pb[p] &&
					pa[p + 1] === pb[p + 1] &&
					pa[p + 2] === pb[p + 2] &&
					pa[p + 3] === pb[p + 3];
				if (same) {
					const grey = 255 - ((pa[p] + pa[p + 1] + pa[p + 2]) / 3) * 0.3;
					out[p] = out[p + 1] = out[p + 2] = pa[p + 3] ? grey : 255;
					out[p + 3] = 255;
					continue;
				}
				n++;
				const x = (p / 4) % width;
				const y = Math.floor(p / 4 / width);
				x0 = Math.min(x0, x);
				x1 = Math.max(x1, x);
				y0 = Math.min(y0, y);
				y1 = Math.max(y1, y);
				const inkA = pa[p + 3] > 0;
				const inkB = pb[p + 3] > 0;
				out[p] = inkA ? 220 : 40;
				out[p + 1] = 40;
				out[p + 2] = inkB ? 220 : 40;
				out[p + 3] = 255;
			}
			const c = document.createElement('canvas');
			c.width = width;
			c.height = height;
			c.getContext('2d').putImageData(img, 0, 0);
			return [
				{
					chart,
					labels,
					url: c.toDataURL(),
					n,
					box: n ? `x ${x0}–${x1}, y ${y0}–${y1} of ${width}×${height}` : ''
				}
			];
		});
	}

	/** Leave the page with every control off, whatever happened. */
	function restoreProduction() {
		if (m4Parity.swapScale || parallelParity.reverseScales) {
			m4Parity.swapScale = false;
			parallelParity.reverseScales = false;
			generation++;
		}
		status = '';
		running = false;
	}

	// ---- Baseline across builds, for M4 and parallel coordinates ----

	const DB_NAME = 'scale-source-parity';
	const STORE = 'baseline';
	const KEY = 'immediate';

	/** One IndexedDB request in its own transaction. */
	function withStore(mode, request) {
		return new Promise((resolve, reject) => {
			const open = indexedDB.open(DB_NAME, 1);
			open.onupgradeneeded = () => open.result.createObjectStore(STORE);
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const db = open.result;
				const tx = db.transaction(STORE, mode);
				const req = request(tx.objectStore(STORE));
				tx.oncomplete = () => {
					db.close();
					resolve(req.result);
				};
				tx.onerror = () => {
					db.close();
					reject(tx.error);
				};
			};
		});
	}

	async function loadBaselineInfo() {
		const stored = await withStore('readonly', (store) => store.get(KEY));
		return stored ? { recordedAt: stored.recordedAt, count: stored.charts.length } : null;
	}

	/**
	 * Two remounts, and they must agree. Settling only proves a chart stopped
	 * moving within one mount; a baseline is compared against a later mount, so
	 * a chart that settles somewhere different each time would fail every
	 * comparison for reasons of its own. That is refused here, not stored.
	 */
	async function recordBaseline() {
		running = true;
		verdict = null;
		baselineRows = [];
		diffs = [];
		try {
			const { shots } = await draw();
			const { shots: again } = await draw({ label: 'a second remount' });
			const list = canvases();
			const charts = list.map(({ chart }) => chart);
			const unstable = charts.filter((_, i) => differing(shots[i], again[i]) !== 0);
			showDiffs(['first remount', 'second remount'], shots, again, list, unstable);
			if (again.length !== shots.length || unstable.length)
				throw new Error(
					`Not recorded: two remounts of this build drew differently on: ${unstable.join(', ') || 'the canvas count'}.`
				);
			const recordedAt = new Date().toLocaleString();
			await withStore('readwrite', (store) => store.put({ recordedAt, charts, shots }, KEY));
			baselineInfo = { recordedAt, count: charts.length };
			verdict = { ok: true, text: `Baseline recorded: ${charts.length} canvases.` };
		} catch (error) {
			verdict = { ok: false, text: String(error?.message ?? error) };
		} finally {
			restoreProduction();
		}
	}

	/**
	 * This build against the recorded one. Every canvas must match, and each
	 * own-source control must differ on its chart: M4's on the decimating line,
	 * parallel coordinates' on its plot. Both run in one control draw; the other
	 * canvases are not expected to move under it, since neither flag reaches them.
	 */
	async function compareBaseline() {
		running = true;
		verdict = null;
		baselineRows = [];
		diffs = [];
		try {
			const stored = await withStore('readonly', (store) => store.get(KEY));
			if (!stored)
				throw new Error('No baseline recorded. Record one on the build before the change.');

			const { shots: now, ms } = await draw();
			const { shots: control } = await draw({
				label: 'the controls',
				allowBlank: true,
				minMs: ms,
				m4Swap: true,
				parallelReverse: true
			});
			const list = canvases();
			const charts = list.map(({ chart }) => chart);
			if (charts.join('|') !== stored.charts.join('|'))
				throw new Error('The charts on the page are not the ones the baseline recorded.');

			baselineRows = list.map(({ chart, control: kind }, i) => ({
				chart,
				kind,
				now: differing(stored.shots[i], now[i]),
				control: differing(stored.shots[i], control[i])
			}));

			const mismatched = baselineRows.filter((r) => r.now !== 0).map((r) => r.chart);
			showDiffs(['baseline', 'this build'], stored.shots, now, list, mismatched);
			const missing = ['m4', 'parallel'].filter(
				(kind) => !baselineRows.some((r) => r.kind === kind)
			);
			const controlBlind = baselineRows
				.filter((r) => r.kind !== 'chart' && r.control === 0)
				.map((r) => r.chart);

			if (missing.length)
				verdict = { ok: false, text: `No chart on the page for: ${missing.join(', ')}.` };
			else if (controlBlind.length)
				verdict = {
					ok: false,
					text: `The control did not differ on: ${controlBlind.join(', ')}. The comparison cannot see a wrong scale reaching it.`
				};
			else if (mismatched.length)
				verdict = {
					ok: false,
					text: `This build differs from the baseline on: ${mismatched.join(', ')}.`
				};
			else
				verdict = {
					ok: true,
					text: `Identical to the baseline on all ${charts.length} canvases, and both own-source controls differed.`
				};
		} catch (error) {
			verdict = { ok: false, text: String(error?.message ?? error) };
		} finally {
			restoreProduction();
		}
	}
</script>

<div class="page">
	<h1>Scale source parity</h1>
	<p>
		Draws every chart below and compares it, pixel for pixel, with a baseline recorded on the
		previous build: record on the commit before a change, compare on the commit after. Every canvas
		must match, and each own-path chart's control must change it: binning the M4 line by its y
		scale, and giving each parallel axis another axis's scale.
	</p>
	<p>
		Covers: continuous × continuous, a sorted band x, a band y, log and symlog, a line, an area with
		auto-dots (which reads the raw params in mark code), a facet grid sharing scales across cells, a
		decimating M4 line, and parallel coordinates (its own scale per axis). Keep the tab in front
		while it runs, since a hidden tab stops rendering.
		{#if baselineInfo}
			Stored baseline: {baselineInfo.count} canvases, recorded {baselineInfo.recordedAt}.
		{:else}
			No baseline stored.
		{/if}
	</p>

	<button onclick={recordBaseline} disabled={!loaded || running}>Record baseline</button>
	<button onclick={compareBaseline} disabled={!loaded || running || !baselineInfo}>
		Compare with baseline
	</button>
	{#if status}<span class="status">{status}</span>{/if}

	{#if verdict}
		<p class="verdict" class:ok={verdict.ok}>{verdict.ok ? 'PASS' : 'FAIL'} — {verdict.text}</p>
	{/if}

	{#if baselineRows.length}
		<table>
			<thead>
				<tr>
					<th>chart</th>
					<th>this build vs baseline</th>
					<th>own-source controls vs baseline</th>
				</tr>
			</thead>
			<tbody>
				{#each baselineRows as row, i (i)}
					<tr>
						<td>{row.chart}</td>
						<td class:bad={row.now !== 0}>{row.now}</td>
						<td class:bad={row.kind !== 'chart' && row.control === 0}>{row.control}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#each diffs as d (d.chart)}
		<figure class="diff">
			<img src={d.url} alt="Where {d.labels[0]} and {d.labels[1]} differ on {d.chart}" />
			<figcaption>
				<strong>{d.chart}</strong>: {d.n} px differ, in {d.box}.
				<span class="a">red</span>: ink only in {d.labels[0]};
				<span class="b">blue</span>: ink only in {d.labels[1]}; purple: both, different colour.
			</figcaption>
		</figure>
	{/each}

	{#if loadError}
		<p class="verdict">Failed to load data: {loadError}</p>
	{:else if loaded}
		<div class="charts" bind:this={chartsEl}>
			{#key generation}
				<section data-chart="dots linear×linear">
					<h2>Dots, linear × linear</h2>
					<div class="chart">
						<ChartContainer>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<Grid />
										<DotsMark
											table="penguins"
											x="bill_length"
											y="bill_depth"
											fill="species"
											r={3}
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section data-chart="bars band×linear, sorted">
					<h2>Bars, band x sorted by count</h2>
					<div class="chart">
						<ChartContainer>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<Grid />
										<BarMarkY
											table="penguins"
											x="island"
											y={count()}
											fill="island"
											sort={{ x: 'y', order: 'desc' }}
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section data-chart="bars linear×band">
					<h2>Bars, band y</h2>
					<div class="chart">
						<ChartContainer>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<BarMarkX table="penguins" x={count()} y="species" fill="species" />
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section data-chart="dots log×symlog">
					<h2>Dots, log x × symlog y</h2>
					<div class="chart">
						<ChartContainer>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<DotsMark
											table="parity_series"
											x="grows"
											y="signed"
											r={3}
											preferredXScaleType="log"
											preferredYScaleType="symlog"
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section data-chart="line linear×log">
					<h2>Line, log y</h2>
					<div class="chart">
						<ChartContainer>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<LineMark
											table="parity_series"
											x="step"
											y="grows"
											strokeWidth={2}
											preferredYScaleType="log"
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section data-chart="area with auto-dots">
					<h2>Area with auto-dots (reads the raw params)</h2>
					<div class="chart">
						<ChartContainer>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<AreaMarkY
											table="parity_series"
											x="step"
											y="wave"
											fillOpacity={0.4}
											dotRadius={-3}
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section data-chart="line, M4 decimating" data-control="m4">
					<h2>Line, M4 decimating (200k points, 3 series)</h2>
					<div class="chart">
						<ChartContainer>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<LineMark
											table="parity_dense"
											x="x"
											y="y"
											stroke="series"
											strokeWidth={1}
											lod={{ decimate: true, dots: false }}
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section data-chart="parallel coordinates" data-control="parallel">
					<h2>Parallel coordinates (4 axes, a scale each)</h2>
					<div class="chart">
						<ChartContainer clipPadding={30}>
							{#snippet background()}<Frame /><ParallelAxes />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<ParallelCoordinatesMark
											table="penguins"
											columns={['bill_length', 'bill_depth', 'flipper_length', 'body_mass']}
											stroke="species"
											opacity={0.5}
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section data-chart="facet grid, dots">
					<h2>Facet grid, fx = species</h2>
					<div class="chart wide">
						<ChartContainer fx="species">
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<DotsMark table="penguins" x="flipper_length" y="body_mass" fill="sex" r={3} />
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>
			{/key}
		</div>
	{:else}
		<p>Loading…</p>
	{/if}
</div>

<style>
	.page {
		padding: 16px;
		max-width: 1100px;
		font-size: 14px;
	}
	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 16px;
		margin-top: 16px;
	}
	.chart {
		height: 240px;
	}
	.diff img {
		max-width: 100%;
		border: 1px solid #ccc;
	}
	.diff .a {
		color: rgb(220, 40, 40);
	}
	.diff .b {
		color: rgb(40, 40, 220);
	}
	.wide {
		grid-column: 1 / -1;
	}
	section:has(.wide) {
		grid-column: 1 / -1;
	}
	h2 {
		font-size: 13px;
		margin: 0 0 4px;
	}
	.status {
		margin-left: 8px;
		color: #666;
	}
	.verdict {
		font-weight: 600;
		color: #c62828;
	}
	.verdict.ok {
		color: #2e7d32;
	}
	table {
		border-collapse: collapse;
		margin-top: 8px;
	}
	td,
	th {
		border: 1px solid #ddd;
		padding: 4px 8px;
		text-align: right;
	}
	td:first-child,
	th:first-child {
		text-align: left;
	}
	td.bad {
		background: #ffebee;
	}
</style>
