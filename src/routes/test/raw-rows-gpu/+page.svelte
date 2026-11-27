<script>
	/**
	 * Raw rows on the GPU, a spike (spike.ts): the columns generated once on the
	 * GPU, a brush as a compute pass writing one bit per row, a pan or zoom as a
	 * uniform. A scripted session measures what a frame costs per phase.
	 *
	 *   ?rows=N      rows (default 1000000; 10000000 is the other case of interest)
	 *   ?mode=       full     every row a blended dot, as Dots draws today (default)
	 *                density  rows counted per grid cell, one fullscreen draw
	 *                rep      one row per grid cell (the highest index), a dot each
	 *   ?cell=N      grid cell edge in device pixels (default 1 for density, 2 for rep)
	 *   ?r=N         dot radius in CSS pixels (default 1.5)
	 *   ?alpha=N     dot opacity (default 0.5)
	 *   ?msaa=1      no multisampling (default 4, as the library draws)
	 *
	 * Run session, wait for the table, Save log (rawrows-<variant>.json in
	 * Downloads). One run per page load. Keep the window as it is between runs
	 * you compare.
	 *
	 * The session, in phases, every frame drawn:
	 *   draw     2 s, nothing changes: the cost of a redraw
	 *   pan      3 s, the view slides: the grid is rebuilt per frame (density, rep)
	 *   zoom     3 s, in to 8x and back
	 *   brush    3 s, a 1D brush sweeps another column: the mask is rewritten per frame
	 *   brush2d  3 s, a rectangle on x and y sweeps, with 6 of 12 categories kept
	 *   end      1 s
	 *
	 * Per frame: the interval, the main-thread time to encode and submit, and
	 * the GPU time of each pass (timestamp queries).
	 */
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { Spike } from './spike';

	const params = page.url.searchParams;
	const ROWS = Math.max(1000, Math.round(Number(params.get('rows')) || 1_000_000));
	const MODES = ['full', 'density', 'rep'];
	const MODE = MODES.includes(params.get('mode')) ? params.get('mode') : 'full';
	const CELL = Math.max(1, Math.round(Number(params.get('cell')) || (MODE === 'rep' ? 2 : 1)));
	const RADIUS = Number(params.get('r')) || 1.5;
	const ALPHA = Number(params.get('alpha')) || 0.5;
	const MSAA = params.get('msaa') === '1' ? 1 : 4;
	const VARIANT = `${ROWS >= 1e6 ? `${ROWS / 1e6}m` : ROWS}-${MODE}${
		params.has('cell') ? `-cell${CELL}` : ''
	}${MSAA === 1 ? '-msaa1' : ''}`;

	const WIDTH = 1200;
	const HEIGHT = 750;

	/** @type {HTMLCanvasElement} */
	let canvas = $state();
	/** @type {Spike | null} */
	let spike = $state.raw(null);
	let ready = $state(false);
	let running = $state(false);
	let done = $state(false);
	let error = $state('');
	let summary = $state(null);
	let adapterInfo = $state('');
	let raf = 0;

	const SESSION = [
		['draw', 2000],
		['pan', 3000],
		['zoom', 3000],
		['brush', 3000],
		['brush2d', 3000],
		['end', 1000]
	];

	// One state object, rewritten per frame: the session allocates nothing.
	const frameState = { view: [0, 1, 0, 1], brush: null, rect: null, categories: null };
	const brush = [0, 1];
	const rect = [0, 1, 0, 1];

	/** The phase at `t` ms into the session and its state, or null past the end. */
	function at(t) {
		let start = 0;
		for (const [name, length] of SESSION) {
			if (t < start + length) {
				const u = (t - start) / length;
				frameState.view[0] = 0;
				frameState.view[1] = 1;
				frameState.view[2] = 0;
				frameState.view[3] = 1;
				frameState.brush = null;
				frameState.rect = null;
				frameState.categories = null;
				if (name === 'pan') {
					// Slightly zoomed, so there is somewhere to slide to.
					const s = 1.25;
					frameState.view[0] = 0.1 + 0.1 * Math.sin(2 * Math.PI * u);
					frameState.view[1] = s;
					frameState.view[2] = 0.1;
					frameState.view[3] = s;
				} else if (name === 'zoom') {
					const s = Math.exp(Math.sin(Math.PI * u) * Math.log(8));
					frameState.view[0] = 0.5 - 0.5 / s;
					frameState.view[1] = s;
					frameState.view[2] = 0.5 - 0.5 / s;
					frameState.view[3] = s;
				} else if (name === 'brush') {
					brush[0] = 0.8 * u;
					brush[1] = brush[0] + 0.2;
					frameState.brush = brush;
				} else if (name === 'brush2d') {
					rect[0] = 0.7 * u;
					rect[1] = rect[0] + 0.3;
					rect[2] = 0.2;
					rect[3] = 0.8;
					frameState.rect = rect;
					frameState.categories = 0x555;
				}
				return name;
			}
			start += length;
		}
		return null;
	}

	function runSession() {
		running = true;
		let t0 = 0;
		let last = '';
		const tick = (ts) => {
			if (!t0) {
				t0 = ts;
				performance.mark(`fjader:session:${VARIANT}`);
			}
			const name = at(ts - t0);
			if (name === null) {
				performance.mark(`fjader:end:${VARIANT}`);
				summary = spike.summarize();
				running = false;
				done = true;
				return;
			}
			if (name !== last) {
				performance.mark(`fjader:phase:${name}`);
				last = name;
			}
			spike.frame(ts, name, frameState);
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
	}

	function save() {
		const blob = new Blob(
			[
				JSON.stringify({
					variant: VARIANT,
					params: Object.fromEntries(params),
					options: spike.options,
					grid: { w: spike.gridW, h: spike.gridH },
					bytes: spike.bytes,
					canvas: { w: canvas.width, h: canvas.height },
					viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
					userAgent: navigator.userAgent,
					adapter: adapterInfo,
					timed: spike.timed,
					summary,
					frames: spike.toJSON()
				})
			],
			{ type: 'application/json' }
		);
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `rawrows-${VARIANT}.json`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	onMount(async () => {
		try {
			const dpr = devicePixelRatio || 1;
			canvas.width = Math.round(WIDTH * dpr);
			canvas.height = Math.round(HEIGHT * dpr);
			spike = await Spike.create(canvas, {
				rows: ROWS,
				mode: MODE,
				cell: CELL,
				radius: RADIUS * dpr,
				alpha: ALPHA,
				msaa: MSAA
			});
			const info = spike.device.adapterInfo;
			adapterInfo = info ? `${info.vendor} ${info.architecture} ${info.description}`.trim() : '';
			// One frame, so the page shows the data before the session.
			at(0);
			requestAnimationFrame((ts) => spike.frame(ts, 'draw', frameState));
			ready = true;
		} catch (e) {
			error = e.message;
		}
	});

	onDestroy(() => {
		// Runs on the server too, where there is no frame to cancel.
		if (raf) cancelAnimationFrame(raf);
		spike?.destroy();
	});

	const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(d));
	const mb = (bytes) => (bytes / 1e6).toFixed(1);
</script>

<svelte:head><title>Raw rows on the GPU</title></svelte:head>

<div class="page">
	<header>
		<strong>Raw rows on the GPU</strong>
		<span class="variant">{VARIANT}</span>
		<button disabled={!ready || running || done} onclick={runSession}>
			{running ? 'running…' : done ? 'done (reload to rerun)' : 'Run session'}
		</button>
		<button disabled={!done} onclick={save}>Save log</button>
		{#if error}<span class="error">{error}</span>{/if}
		{#if !ready && !error}<span class="note">generating {ROWS.toLocaleString()} rows…</span>{/if}
	</header>

	<canvas bind:this={canvas} style:width="{WIDTH}px" style:height="{HEIGHT}px"></canvas>

	{#if ready && spike}
		<p class="note">
			{ROWS.toLocaleString()} rows, mode {MODE}, canvas {canvas.width}×{canvas.height}
			{#if MODE !== 'full'}, grid {spike.gridW}×{spike.gridH} (cell {CELL} px){/if}. On the GPU:
			columns {mb(spike.bytes.columns)} MB, mask {mb(spike.bytes.mask)} MB, grid {mb(
				spike.bytes.grid
			)} MB, multisample target {mb(spike.bytes.msaa)} MB.
			{#if !spike.timed}No timestamp queries on this device: GPU times are missing.{/if}
		</p>
	{/if}

	{#if summary}
		<table>
			<thead>
				<tr>
					<th>phase</th>
					<th>frames</th>
					<th>dt p50</th>
					<th>dt p95</th>
					<th>dt max</th>
					<th>dropped</th>
					<th>encode p50</th>
					<th>encode p95</th>
					<th>mask p50</th>
					<th>bin p50</th>
					<th>render p50</th>
					<th>GPU total p50</th>
					<th>GPU total p95</th>
					<th>GPU total max</th>
				</tr>
			</thead>
			<tbody>
				{#each summary.phases as p (p.phase)}
					<tr>
						<td>{p.phase}</td>
						<td>{p.frames}</td>
						<td>{fmt(p.dtP50, 1)}</td>
						<td>{fmt(p.dtP95, 1)}</td>
						<td>{fmt(p.dtMax, 1)}</td>
						<td class:bad={p.droppedPct > 5}>{fmt(p.droppedPct, 0)}%</td>
						<td>{fmt(p.encodeP50)}</td>
						<td>{fmt(p.encodeP95)}</td>
						<td>{fmt(p.gpu?.mask.p50)}</td>
						<td>{fmt(p.gpu?.bin.p50)}</td>
						<td>{fmt(p.gpu?.render.p50)}</td>
						<td>{fmt(p.gpu?.total.p50)}</td>
						<td>{fmt(p.gpu?.total.p95)}</td>
						<td>{fmt(p.gpu?.total.max)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p class="note">
			ms. Cadence {fmt(summary.cadence)} ms (the first phase's median interval). encode = main thread,
			one frame's commands and submit. mask, bin, render = GPU time of each pass (timestamp queries);
			a pass that did not run counts 0.
		</p>
	{/if}
</div>

<style>
	.page {
		padding: 12px;
		font:
			13px/1.4 system-ui,
			sans-serif;
	}
	header {
		display: flex;
		gap: 12px;
		align-items: center;
		margin-bottom: 8px;
	}
	.variant {
		font-family: ui-monospace, monospace;
		color: #666;
	}
	canvas {
		display: block;
		border: 1px solid #ccc;
	}
	table {
		border-collapse: collapse;
		margin-top: 10px;
		font-variant-numeric: tabular-nums;
	}
	th,
	td {
		padding: 2px 8px;
		text-align: right;
		border-bottom: 1px solid #eee;
	}
	th:first-child,
	td:first-child {
		text-align: left;
	}
	.note {
		color: #666;
		max-width: 1200px;
	}
	.error,
	.bad {
		color: #b00;
	}
</style>
