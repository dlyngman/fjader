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
	 * The control. `swapped` is the immediates with x and y exchanged — a wrong
	 * scale reaching the shader, deliberately. It MUST differ from `table` on
	 * every chart. If it does not, the comparison cannot see the failure it
	 * exists for, and a clean `immediate` result means nothing.
	 */
	import { onMount, tick } from 'svelte';
	import { loadParquet, count } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import { scaleTemplateSystem } from '$lib/gpu/ScaleTemplateSystem';
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

	const { queryEngine } = initDivePlot();

	let loaded = $state(false);
	let loadError = $state(null);
	/** Bumped to remount every chart, so its pipelines rebuild against the source. */
	let generation = $state(0);
	let running = $state(false);
	let status = $state('');
	/** One row per canvas: which chart, and what each comparison found. */
	let rows = $state([]);
	let verdict = $state(null);

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

	async function capture(canvas) {
		const bitmap = await createImageBitmap(canvas);
		const off = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx = off.getContext('2d');
		ctx.drawImage(bitmap, 0, 0);
		bitmap.close();
		return ctx.getImageData(0, 0, off.width, off.height).data;
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
		for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) return false;
		return true;
	}

	/**
	 * Draw everything through `source` and read it back once it has settled:
	 * two captures 300ms apart that agree, pixel for pixel. Data loads and
	 * scale springs both finish on their own time, and a fixed wait would
	 * compare a frame mid-animation against a frame at rest.
	 */
	async function drawWith(source) {
		scaleTemplateSystem.chartScaleSource = source;
		generation++;
		await tick();
		status = `drawing through "${source}"…`;
		let previous = null;
		for (let attempt = 0; attempt < 40; attempt++) {
			await sleep(300);
			const list = canvases();
			const shots = [];
			for (const { canvas } of list) shots.push(await capture(canvas));
			const settled =
				previous &&
				previous.length === shots.length &&
				shots.length > 0 &&
				shots.every((s, i) => differing(s, previous[i]) === 0);
			if (settled) return shots;
			previous = shots;
		}
		throw new Error(`"${source}" never settled: captures kept changing for 12s.`);
	}

	async function run() {
		running = true;
		verdict = null;
		rows = [];
		try {
			const table = await drawWith('table');
			const swapped = await drawWith('swapped');
			const immediate = await drawWith('immediate');
			const list = canvases();

			rows = list.map(({ chart }, i) => ({
				chart,
				blank: blank(table[i]),
				immediate: differing(table[i], immediate[i]),
				swapped: differing(table[i], swapped[i]),
				pixels: table[i].length / 4
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
			// Leave the page on production's source whatever happened.
			if (scaleTemplateSystem.chartScaleSource !== 'immediate') {
				scaleTemplateSystem.chartScaleSource = 'immediate';
				generation++;
			}
			status = '';
			running = false;
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
		auto-dots (which reads the raw params in mark code), and a facet grid sharing scales across
		cells. Keep the tab in front while it runs, since a hidden tab stops rendering.
	</p>

	<button onclick={run} disabled={!loaded || running}>
		{running ? 'Running…' : 'Run parity check'}
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
