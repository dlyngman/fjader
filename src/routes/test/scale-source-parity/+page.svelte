<script>
	/**
	 * Scale source parity: the same charts drawn with their scales read from the
	 * pass's immediates and from the old global table, compared pixel for pixel.
	 *
	 * Why pixels. The failure this guards against is a wrong scale reaching a
	 * shader — a chart drawing through another chart's params, or x and y
	 * exchanged — and that renders plausible, wrong pixels rather than an error.
	 * Unit tests reach neither the pass that pushes the immediates nor the shader
	 * that reads them, so the only honest check is the one that looks.
	 *
	 * How. `scaleTemplateSystem.chartScaleSource` picks what `chartScaleX/Y`
	 * compile to, and it is part of every cache key, so remounting the charts
	 * under a new source builds new pipelines against it. Each source is drawn,
	 * left to settle (two identical captures in a row), and read back.
	 *
	 * Readback goes through the coordinator, which copies each canvas texture in
	 * the frame that draws it. `createImageBitmap` on the element saw every
	 * chart as transparent while all of them were on screen: a WebGPU canvas's
	 * texture expires once presented.
	 *
	 * The control. `swapped` is the immediates with x and y exchanged — a wrong
	 * scale reaching the shader, deliberately. It MUST differ from `table` on
	 * every chart. If it does not, the comparison cannot see the failure it
	 * exists for, and a clean `immediate` result means nothing.
	 *
	 * M4 has no old path left to switch to once its scale moves, so it is
	 * checked against the previous BUILD instead: record a baseline on the
	 * commit before the change, compare on the commit after. The captures live
	 * in IndexedDB between the two. Its control is `m4Parity.swapScale`, which
	 * bins the decimating line by its y scale — the comparison must see that on
	 * the M4 chart.
	 */
	import { onMount, tick } from 'svelte';
	import { loadParquet, count } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import { scaleTemplateSystem } from '$lib/gpu/ScaleTemplateSystem';
	import { m4Parity } from '$lib/gpu/decimation/M4Decimator.svelte';
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
		AreaMarkY
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';

	const { queryEngine, gpuCoordinator } = initDivePlot();
	// Before any chart mounts: a canvas reads it when it configures its context.
	gpuCoordinator.readbackEnabled = true;

	let loaded = $state(false);
	let loadError = $state(null);
	/** Bumped to remount every chart, so its pipelines rebuild against the source. */
	let generation = $state(0);
	let running = $state(false);
	let status = $state('');
	/** One row per canvas: which chart, and what each comparison found. */
	let rows = $state([]);
	let verdict = $state(null);
	/** One row per canvas for the baseline comparison. */
	let baselineRows = $state([]);
	/** When the stored baseline was recorded, and of how many canvases. */
	let baselineInfo = $state(null);

	/** @type {HTMLElement | undefined} */
	let chartsEl = $state();

	onMount(async () => {
		try {
			await queryEngine.exec([
				loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString()
			]);
			// Deterministic: a remount re-queries, and a random() here would make
			// every source differ from every other for reasons of its own.
			await queryEngine.exec([
				`CREATE OR REPLACE TABLE parity_series AS
				WITH RECURSIVE points AS (
					SELECT 0 AS idx UNION ALL SELECT idx + 1 FROM points WHERE idx < 199
				)
				SELECT
					idx AS x,
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

	/** Every chart canvas, in document order, with the section it belongs to. */
	function canvases() {
		return [...(chartsEl?.querySelectorAll('canvas') ?? [])].map((canvas) => ({
			canvas,
			chart: canvas.closest('[data-chart]')?.getAttribute('data-chart') ?? '?'
		}));
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
	 * Draw everything through `source` and read it back once it has settled:
	 * two captures 300ms apart that agree, pixel for pixel. Data loads and
	 * scale springs both finish on their own time, and a fixed wait would
	 * compare a frame mid-animation against a frame at rest.
	 *
	 * A correct source must draw something on every canvas before it counts as
	 * settled. The control is allowed to be blank — a wrong scale usually puts
	 * every mark off the canvas, which is the point of it — but blank is also
	 * what a chart looks like before its data arrives, and nothing the page can
	 * see tells the two apart. So a blank control is accepted only after
	 * `minMs`, the time a correct source needed to draw the same charts.
	 */
	async function drawWith(source, { allowBlank = false, minMs = 0, m4Swap = false } = {}) {
		scaleTemplateSystem.chartScaleSource = source;
		m4Parity.swapScale = m4Swap;
		generation++;
		await tick();
		status = `drawing through "${source}"…`;
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
			throw new Error(`"${source}": ${absent.length} ${of} never rendered: ${absent.join(', ')}.`);
		if (noDraws.length)
			throw new Error(
				`"${source}": ${noDraws.length} ${of} rendered but issued no draws: ${noDraws.join(', ')}.`
			);
		if (blankDrawn.length)
			throw new Error(
				`"${source}": ${blankDrawn.length} ${of} issued draws but stayed blank: ${blankDrawn.join(', ')}. Either the marks land off the canvas or their data never arrived.`
			);
		throw new Error(`"${source}" never settled: captures kept changing for 12s.`);
	}

	async function run() {
		running = true;
		verdict = null;
		rows = [];
		try {
			const { shots: table, ms } = await drawWith('table');
			const { shots: swapped } = await drawWith('swapped', { allowBlank: true, minMs: ms });
			const { shots: immediate } = await drawWith('immediate');
			const list = canvases();

			rows = list.map(({ chart }, i) => ({
				chart,
				blank: blank(table[i]),
				immediate: differing(table[i], immediate[i]),
				swapped: differing(table[i], swapped[i]),
				pixels: table[i] ? table[i].length / 4 : 0
			}));

			const readbackBroken = rows.some((r) => r.blank);
			const controlBlind = rows.filter((r) => r.swapped === 0).map((r) => r.chart);
			const mismatched = rows.filter((r) => r.immediate !== 0).map((r) => r.chart);

			if (rows.length === 0) verdict = { ok: false, text: 'No canvases found.' };
			else if (readbackBroken)
				verdict = {
					ok: false,
					text: 'A capture came back blank, so readback is not seeing the charts. Nothing below means anything.'
				};
			else if (controlBlind.length)
				verdict = {
					ok: false,
					text: `The control did not differ on: ${controlBlind.join(', ')}. The comparison cannot see a wrong scale there, so a clean result there proves nothing.`
				};
			else if (mismatched.length)
				verdict = {
					ok: false,
					text: `Immediates differ from the table on: ${mismatched.join(', ')}.`
				};
			else
				verdict = {
					ok: true,
					text: `Parity on all ${rows.length} canvases, and the control differed on every one.`
				};
		} catch (error) {
			verdict = { ok: false, text: String(error?.message ?? error) };
		} finally {
			restoreProduction();
		}
	}

	/** Leave the page on production's sources whatever happened. */
	function restoreProduction() {
		if (scaleTemplateSystem.chartScaleSource !== 'immediate' || m4Parity.swapScale) {
			scaleTemplateSystem.chartScaleSource = 'immediate';
			m4Parity.swapScale = false;
			generation++;
		}
		status = '';
		running = false;
	}

	// ---- Baseline across builds, for M4 ----

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
		try {
			const { shots } = await drawWith('immediate');
			const { shots: again } = await drawWith('immediate');
			const charts = canvases().map(({ chart }) => chart);
			const unstable = charts.filter((_, i) => differing(shots[i], again[i]) !== 0);
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
	 * This build against the recorded one. Every canvas must match, and the M4
	 * control must differ on the decimating chart. The other canvases are not
	 * expected to move under the control: only M4 reads it.
	 */
	async function compareBaseline() {
		running = true;
		verdict = null;
		baselineRows = [];
		try {
			const stored = await withStore('readonly', (store) => store.get(KEY));
			if (!stored)
				throw new Error('No baseline recorded. Record one on the build before the change.');

			const { shots: now, ms } = await drawWith('immediate');
			const { shots: control } = await drawWith('immediate', {
				allowBlank: true,
				minMs: ms,
				m4Swap: true
			});
			const charts = canvases().map(({ chart }) => chart);
			if (charts.join('|') !== stored.charts.join('|'))
				throw new Error('The charts on the page are not the ones the baseline recorded.');

			baselineRows = charts.map((chart, i) => ({
				chart,
				m4: chart.includes('M4'),
				now: differing(stored.shots[i], now[i]),
				control: differing(stored.shots[i], control[i])
			}));

			const mismatched = baselineRows.filter((r) => r.now !== 0).map((r) => r.chart);
			const m4Rows = baselineRows.filter((r) => r.m4);
			const controlBlind = m4Rows.filter((r) => r.control === 0).map((r) => r.chart);

			if (m4Rows.length === 0) verdict = { ok: false, text: 'No M4 chart on the page.' };
			else if (controlBlind.length)
				verdict = {
					ok: false,
					text: `The M4 control did not differ on: ${controlBlind.join(', ')}. The comparison cannot see a wrong scale reaching the binning.`
				};
			else if (mismatched.length)
				verdict = {
					ok: false,
					text: `This build differs from the baseline on: ${mismatched.join(', ')}.`
				};
			else
				verdict = {
					ok: true,
					text: `Identical to the baseline on all ${charts.length} canvases, and the M4 control differed.`
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
		Draws every chart below through three sources for its x and y scale params, and compares pixels
		against <code>table</code>, the old path through the global scale table:
	</p>
	<ul>
		<li><code>immediate</code>, what ships. It must match <code>table</code> exactly.</li>
		<li>
			<code>swapped</code>, immediates with x and y exchanged: the control. It must
			<strong>differ</strong> on every chart, or the check cannot see the failure it is for.
		</li>
	</ul>
	<p>
		Covers: continuous × continuous, a sorted band x, a band y, log and symlog, a line, an area with
		auto-dots (which reads the raw params in mark code), a facet grid sharing scales across cells,
		and a decimating M4 line. Keep the tab in front while it runs, since a hidden tab stops
		rendering.
	</p>
	<p>
		<strong>Across builds, for M4:</strong> record a baseline on the commit before a change, then
		compare on the commit after. Every canvas must match, and binning the M4 line by its y scale
		(the control) must change it.
		{#if baselineInfo}
			Stored baseline: {baselineInfo.count} canvases, recorded {baselineInfo.recordedAt}.
		{:else}
			No baseline stored.
		{/if}
	</p>

	<button onclick={run} disabled={!loaded || running}>
		{running ? 'Running…' : 'Run parity check'}
	</button>
	<button onclick={recordBaseline} disabled={!loaded || running}>Record baseline</button>
	<button onclick={compareBaseline} disabled={!loaded || running || !baselineInfo}>
		Compare with baseline
	</button>
	{#if status}<span class="status">{status}</span>{/if}

	{#if verdict}
		<p class="verdict" class:ok={verdict.ok}>{verdict.ok ? 'PASS' : 'FAIL'} — {verdict.text}</p>
	{/if}

	{#if rows.length}
		<table>
			<thead>
				<tr>
					<th>chart</th>
					<th>immediate vs table</th>
					<th>swapped vs table (control)</th>
					<th>pixels</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row, i (i)}
					<tr>
						<td>{row.chart}</td>
						<td class:bad={row.immediate !== 0}>{row.immediate}</td>
						<td class:bad={row.swapped === 0}>{row.swapped}</td>
						<td>{row.pixels}{row.blank ? ' (blank)' : ''}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if baselineRows.length}
		<table>
			<thead>
				<tr>
					<th>chart</th>
					<th>this build vs baseline</th>
					<th>M4 control vs baseline</th>
				</tr>
			</thead>
			<tbody>
				{#each baselineRows as row, i (i)}
					<tr>
						<td>{row.chart}</td>
						<td class:bad={row.now !== 0}>{row.now}</td>
						<td class:bad={row.m4 && row.control === 0}>{row.control}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

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
											x="x"
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
											x="x"
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

				<section data-chart="line, M4 decimating">
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
