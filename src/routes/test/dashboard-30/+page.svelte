<script>
	/**
	 * Dashboard-30: thirty charts on one screen, all reacting to one selection,
	 * driven by a scripted session, with a per-frame cost probe. Its variants
	 * measure what text costs while data animates: labels (on the GPU) and axes
	 * (SVG).
	 *
	 *   ?labels=      the bar charts' labels (charts 1-11, 29, 30):
	 *                 attached  <Labels> on the bars, reading their placement and
	 *                           rows (default)
	 *                 text      a TextMark per chart: a second mark, query and
	 *                           topN beside the bars
	 *                 0         none
	 *                 Chart 19's histogram labels are a TextMark in every mode
	 *                 but 0 (RectYMark does not host <Labels> yet), so the modes
	 *                 differ only in the bar charts.
	 *   ?axes=0       no axes (with labels=0: the page without text)
	 *   ?charts=N     only the first N charts (default 30)
	 *   ?mutations=1  count DOM mutation records per frame (observing costs too,
	 *                 so leave it off for timing runs)
	 *   ?scale=N      the flights table N times over (default 1: 200k rows)
	 *
	 * Run session, wait for the summary, then Save log (dash30-<variant>.json in
	 * Downloads). One run per page load: reload between runs. Don't move the
	 * mouse while it runs: the script's pointer events go through the charts'
	 * own handlers, and the real mouse would too. Keep the window as it is
	 * between runs you compare (size and display: the cadence is the display's).
	 *
	 * The session, in phases (each frame is tagged with its phase):
	 *   idle        2 s, nothing happening: the floor, and the display cadence
	 *   toggle      clicks on the carrier chart's axis labels (Toggle's margin
	 *               path), each held 1 s: every other chart filters and morphs
	 *   clear       a click on empty plot space clears the toggles
	 *   toggle-wait hover on the carrier chart, until its preagg builds finish
	 *               (capped at 15 s), so the clicks measure the steady state
	 *   brush-wait  hover on the delay histogram, the same wait for its builds
	 *   brush       a 3 s brush sweep: every chart re-queries and morphs per move
	 *   unbrush     the brush cleared, 1.2 s
	 *   sort        every bar chart's sort flipped, three times, 1.2 s each:
	 *               every band axis reorders at once
	 *   pan         a 2 s drag in the time axis margin: seven charts share x
	 *   zoom        wheel in and out in the same margin
	 *   idle-end    1 s
	 *
	 * Per frame: the interval, the main-thread time to the end of rendering, the
	 * GPU time per submit, DOM mutations (opt-in); plus Long Animation Frame
	 * entries (frame-probe.ts). The table below the buttons summarizes per phase.
	 *
	 * Clicks are placed by slot position, not by finding an SVG <text>, so the
	 * script still works once axis labels are drawn on the GPU.
	 */
	import { count, avg } from '@uwdata/mosaic-sql';
	import { initFjader, topN, stackY } from '$lib';
	import { page } from '$app/state';
	import { onMount, onDestroy, tick } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		BarMarkY,
		BarMarkX,
		RectYMark,
		DotsMark,
		AreaMarkY,
		LineMark,
		TextMark,
		Labels,
		IntervalX
	} from '$lib/components';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import { bin } from '$lib/sql/bin';
	import { attachQueryLog } from '$lib/query-engine/debug/query-log';
	import { FrameProbe } from './frame-probe';

	const params = page.url.searchParams;
	/**
	 * `?labels=`, by the names the page and its saved logs use. An unknown value
	 * is shown, not run as the default: a run of the wrong mode is a wrong number.
	 */
	const LABEL_MODES = {
		attached: 'attached',
		text: 'text',
		textmark: 'text',
		0: 'none',
		none: 'none'
	};
	const labelsParam = params.get('labels');
	const LABEL_MODE = labelsParam === null ? 'attached' : (LABEL_MODES[labelsParam] ?? null);
	const LABEL_MODE_ERROR =
		LABEL_MODE === null
			? `Unknown ?labels=${labelsParam}: use attached, text (or textmark), or 0 (or none).`
			: null;
	const LABELS = LABEL_MODE !== 'none';
	const AXES = params.get('axes') !== '0';
	const MUTATIONS = params.get('mutations') === '1';
	const SCALE = Math.max(1, Number(params.get('scale')) || 1);
	const CHART_COUNT = Math.min(30, Math.max(1, Number(params.get('charts')) || 30));
	const VARIANT = `${LABEL_MODE === 'none' ? 'nolabels' : LABEL_MODE === 'text' ? 'textmark' : 'attached'}-${AXES ? 'axes' : 'noaxes'}${
		CHART_COUNT < 30 ? `-c${CHART_COUNT}` : ''
	}${SCALE > 1 ? `-x${SCALE}` : ''}${MUTATIONS ? '-mut' : ''}`;

	const { queryEngine, gpuCoordinator } = initFjader();
	const log = attachQueryLog(queryEngine);

	// Activations (preagg builds a hover starts), so a phase can wait for the
	// ones its hover started: with thirty charts a hover plans ~40 builds that
	// take seconds, and a brush started before they finish reads the base
	// table, queued behind them, which measures the queue rather than the frame.
	let activations = [];
	const activate = queryEngine.activate.bind(queryEngine);
	queryEngine.activate = (group, source) => {
		const p = activate(group, source);
		activations.push(p);
		return p;
	};
	/** Builds stop being waited for here, so a stuck build cannot hang a run. */
	const BUILD_WAIT_CAP_MS = 15_000;

	let isLoaded = $state(false);
	let loadError = $state(LABEL_MODE_ERROR);
	let running = $state(false);
	let done = $state(false);
	let summary = $state(null);
	/** Every bar chart's sort order; the session flips it. */
	let order = $state('desc');

	let dashEl = $state();
	/** @type {FrameProbe | null} */
	let probe = null;
	/** Whether the probe exists: `probe` itself is not reactive, this is. */
	let probeReady = $state(false);
	const events = [];
	let mountedAt = 0;

	// --- The charts ---------------------------------------------------------
	//
	// Each chart has its own x and y labels: a label names a scale, and charts
	// with the same label share it. Only the seven `time` charts share theirs,
	// on purpose, so one pan moves them all.

	const CARRIERS = ['AA', 'DL', 'UA', 'WN', 'B6', 'AS', 'NK', 'F9', 'G4', 'HA'];
	const AIRPORTS = [
		'ATL',
		'DFW',
		'DEN',
		'ORD',
		'LAX',
		'JFK',
		'LAS',
		'MCO',
		'MIA',
		'CLT',
		'SEA',
		'PHX',
		'EWR',
		'SFO',
		'IAH',
		'BOS',
		'FLL',
		'MSP',
		'LGA',
		'DTW'
	];
	const MONTHS = [
		'Jan',
		'Feb',
		'Mar',
		'Apr',
		'May',
		'Jun',
		'Jul',
		'Aug',
		'Sep',
		'Oct',
		'Nov',
		'Dec'
	];
	const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

	const ALL_CHARTS = [
		// Vertical bars on a band x, sorted by value, labelled.
		{
			id: 1,
			kind: 'barY',
			cat: 'carrier',
			title: 'Flights by carrier (click labels)',
			toggle: true
		},
		{ id: 2, kind: 'barY', cat: 'origin', top: 10, title: 'Top origins' },
		{ id: 3, kind: 'barY', cat: 'dest', top: 10, title: 'Top destinations' },
		{ id: 4, kind: 'barY', cat: 'month', title: 'By month' },
		{ id: 5, kind: 'barY', cat: 'weekday', title: 'By weekday' },
		{ id: 6, kind: 'barY', cat: 'dist_band', title: 'By distance band' },
		{ id: 7, kind: 'barY', cat: 'delay_band', title: 'By delay band' },
		{ id: 8, kind: 'barY', cat: 'block', title: 'By departure block' },
		// Horizontal bars on a band y, labelled.
		{ id: 9, kind: 'barX', cat: 'carrier', title: 'Carrier (horizontal)' },
		{ id: 10, kind: 'barX', cat: 'origin', top: 12, title: 'Top origins (horizontal)' },
		{ id: 11, kind: 'barX', cat: 'route', top: 12, title: 'Top routes' },
		// Stacked bars.
		{ id: 12, kind: 'stackY', cat: 'month', fill: 'carrier', title: 'Month × carrier' },
		{ id: 13, kind: 'stackY', cat: 'weekday', fill: 'dist_band', title: 'Weekday × distance' },
		{ id: 14, kind: 'stackY', cat: 'block', fill: 'carrier', title: 'Block × carrier' },
		// Histograms.
		{ id: 15, kind: 'hist', x: 'delay', title: 'Delay (brush)', brush: true },
		{ id: 16, kind: 'hist', x: 'distance', title: 'Distance' },
		{ id: 17, kind: 'hist', x: 'time', title: 'Departure time', shared: true },
		{ id: 18, kind: 'hist', x: 'delay', steps: 200, title: 'Delay, fine' },
		{ id: 19, kind: 'hist', x: 'distance', steps: 30, title: 'Distance (labelled)', labels: true },
		{
			id: 20,
			kind: 'histStack',
			x: 'time',
			fill: 'carrier',
			title: 'Time × carrier',
			shared: true
		},
		// Lines.
		{ id: 21, kind: 'line', x: 'time', y: 'delay', title: 'Mean delay over time', shared: true },
		{
			id: 22,
			kind: 'line',
			x: 'time',
			y: 'distance',
			title: 'Mean distance over time',
			shared: true
		},
		{ id: 23, kind: 'line', x: 'delay', y: 'distance', title: 'Mean distance by delay' },
		// Areas.
		{ id: 24, kind: 'area', x: 'time', title: 'Flights over time', shared: true },
		{
			id: 25,
			kind: 'areaStack',
			x: 'time',
			fill: 'dist_band',
			title: 'Over time × distance',
			shared: true
		},
		// Dots, every row.
		{ id: 26, kind: 'dots', x: 'distance', y: 'delay', title: 'Delay × distance (all rows)' },
		{ id: 27, kind: 'dots', x: 'time', y: 'delay', title: 'Delay × time (all rows)', shared: true },
		{ id: 28, kind: 'dots', x: 'distance', y: 'time', title: 'Time × distance (all rows)' },
		// Value bars: mean delay per category, sorted, labelled with a format.
		{
			id: 29,
			kind: 'barY',
			cat: 'origin',
			top: 10,
			measure: 'delay',
			title: 'Mean delay, top origins'
		},
		{ id: 30, kind: 'barY', cat: 'carrier', measure: 'distance', title: 'Mean distance by carrier' }
	];
	const charts = ALL_CHARTS.slice(0, CHART_COUNT);

	/** An x label: the field, unique per chart unless the chart shares x. */
	/** The measure an axis shows: a mean, or a count. */
	const measureTitle = (c) => (c.measure ? `mean ${c.measure}` : c.y ? `mean ${c.y}` : 'count');
	// Horizontal bars put the category on y and the measure on x.
	const xLabelOf = (c) =>
		c.shared ? 'time' : `${c.kind === 'barX' ? measureTitle(c) : (c.x ?? c.cat)} #${c.id}`;
	const yLabelOf = (c) => `${c.kind === 'barX' ? c.cat : measureTitle(c)} #${c.id}`;
	const measureOf = (c) => (c.measure ? avg(c.measure) : count());
	const transformsOf = (c) => (c.top ? [topN(c.top)] : []);
	const fmtMean = (v) => Number(v).toFixed(0);
	const fmtCount = (v) => {
		const n = Number(v);
		return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`;
	};
	/** A TextMark beside the chart's mark: the bar charts in `text` mode, the labelled histogram in both. */
	const textLabelled = (c) =>
		LABELS && (c.labels || (LABEL_MODE === 'text' && (c.kind === 'barY' || c.kind === 'barX')));
	const ATTACHED = LABEL_MODE === 'attached';

	// --- Scripted pointer ---------------------------------------------------

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const frame = () => new Promise((r) => requestAnimationFrame(r));
	const moveType =
		typeof window !== 'undefined' && 'onpointerrawupdate' in window && window.self === window.top
			? 'pointerrawupdate'
			: 'pointermove';

	const chartEl = (id) => document.querySelector(`[data-chart="${id}"]`);
	const foreground = (id) => chartEl(id)?.querySelector('svg.svg-foreground');
	const plotRect = (id) =>
		chartEl(id).querySelector('rect.interaction-target').getBoundingClientRect();

	function mark(kind, label, extra = {}) {
		events.push({ kind, label, t: performance.now(), ...extra });
		// Mirrored as User Timing, so a Chrome performance trace shows it (docs/measuring.md).
		performance.mark(`fjader:${kind}:${label}`);
	}

	function phase(name) {
		probe?.setPhase(name);
		mark('phase', name);
	}

	function pointer(target, type, x, y, buttons = 0, init = {}) {
		target.dispatchEvent(
			new PointerEvent(type, {
				bubbles: type !== 'pointerenter' && type !== 'pointerleave',
				cancelable: true,
				composed: true,
				pointerId: 1,
				pointerType: 'mouse',
				isPrimary: true,
				button: 0,
				buttons,
				clientX: x,
				clientY: y,
				...init
			})
		);
	}

	let hovered = null;

	function leave() {
		if (hovered == null) return;
		const svg = foreground(hovered);
		const r = svg.getBoundingClientRect();
		pointer(svg, 'pointerleave', r.right + 1, r.top - 1);
		pointer(svg.closest('.chart-cell'), 'pointerleave', r.right + 1, r.top - 1);
		hovered = null;
	}

	function enter(id, x, y) {
		leave();
		hovered = id;
		activations = [];
		const svg = foreground(id);
		pointer(svg.closest('.chart-cell'), 'pointerenter', x, y);
		pointer(svg, 'pointerenter', x, y);
	}

	/** A click in the x axis margin, centred on slot `k` of `n`. */
	function clickSlot(id, k, n, shiftKey = false) {
		const r = plotRect(id);
		const x = r.left + (r.width * (k + 0.5)) / n;
		const y = r.bottom + 10;
		mark('click', `chart ${id} slot ${k}${shiftKey ? ' (shift)' : ''}`);
		foreground(id).dispatchEvent(
			new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey, clientX: x, clientY: y })
		);
	}

	/** A click on empty plot space (top right, above the bars): clears the toggles. */
	function clickEmpty(id) {
		const r = plotRect(id);
		mark('click', `chart ${id} empty`);
		foreground(id).dispatchEvent(
			new MouseEvent('click', {
				bubbles: true,
				cancelable: true,
				clientX: r.right - 4,
				clientY: r.top + 4
			})
		);
	}

	/** A drag over `ms`, one move per frame, along `path(t)` → [x, y]. */
	async function drag(id, path, ms) {
		const svg = foreground(id);
		const [x0, y0] = path(0);
		pointer(svg, 'pointerdown', x0, y0, 1);
		const start = performance.now();
		for (;;) {
			await frame();
			const t = Math.min(1, (performance.now() - start) / ms);
			const [x, y] = path(t);
			pointer(svg, moveType, x, y, 1);
			if (t >= 1) break;
		}
		const [x1, y1] = path(1);
		pointer(svg, 'pointerup', x1, y1, 0);
	}

	function wheel(id, x, y, deltaY) {
		foreground(id).dispatchEvent(
			new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY })
		);
	}

	// --- The session --------------------------------------------------------

	/** Until the activations the last hover started have settled (capped), then a frame. */
	async function builds(label) {
		await frame();
		const started = activations;
		const t0 = performance.now();
		const timedOut = await Promise.race([
			Promise.allSettled(started).then(() => false),
			sleep(BUILD_WAIT_CAP_MS).then(() => true)
		]);
		mark('builds', label, { activations: started.length, ms: performance.now() - t0, timedOut });
		await sleep(300);
	}

	async function runSession() {
		running = true;
		// A synthetic pointer id has no active pointer: capture throws.
		const capture = Element.prototype.setPointerCapture;
		const release = Element.prototype.releasePointerCapture;
		Element.prototype.setPointerCapture = function (id) {
			try {
				capture.call(this, id);
			} catch {
				// NotFoundError for the synthetic pointer.
			}
		};
		Element.prototype.releasePointerCapture = function (id) {
			try {
				release.call(this, id);
			} catch {
				// As above.
			}
		};
		const has = (id) => charts.some((c) => c.id === id);
		try {
			probe.start();
			mark('session', VARIANT);

			phase('idle');
			await sleep(2000);

			if (has(1)) {
				phase('toggle-wait');
				const r = plotRect(1);
				enter(1, r.left + r.width / 2, r.bottom + 10);
				await builds('carrier hover');
				phase('toggle');
				const n = CARRIERS.length;
				for (const [k, shift] of [
					[0, false],
					[3, true],
					[6, false],
					[1, true],
					[8, false]
				]) {
					clickSlot(1, k, n, shift);
					await sleep(1000);
				}
				phase('clear');
				clickEmpty(1);
				await sleep(1200);
				leave();
			}

			if (has(15)) {
				phase('brush-wait');
				const r = plotRect(15);
				const y = r.top + r.height * 0.5;
				const at = (f) => r.left + r.width * f;
				enter(15, at(0.5), y);
				await builds('delay hover');
				phase('brush');
				await drag(
					15,
					(t) => [at(0.25 + 0.35 * (t < 0.5 ? t * 2 : 2 - t * 2) + 0.15 * t), y],
					3000
				);
				await sleep(800);
				phase('unbrush');
				pointer(foreground(15), 'pointerdown', at(0.9), y, 1);
				pointer(foreground(15), 'pointerup', at(0.9), y, 0);
				await sleep(1200);
				leave();
			}

			phase('sort');
			for (let i = 0; i < 3; i++) {
				order = order === 'desc' ? 'asc' : 'desc';
				mark('sort', order);
				await tick();
				await sleep(1200);
			}

			if (has(17)) {
				const r = plotRect(17);
				const y = r.bottom + 10;
				const at = (f) => r.left + r.width * f;
				// The wheel handler zooms only after the pointer has dwelt.
				enter(17, at(0.5), y);
				await sleep(400);
				phase('pan');
				await drag(17, (t) => [at(0.3 + 0.4 * (t < 0.5 ? t * 2 : 2 - t * 2)), y], 2000);
				await sleep(500);
				phase('zoom');
				for (let i = 0; i < 8; i++) {
					wheel(17, at(0.5), y, -100);
					await sleep(60);
				}
				await sleep(600);
				for (let i = 0; i < 8; i++) {
					wheel(17, at(0.5), y, 100);
					await sleep(60);
				}
				await sleep(800);
				leave();
			}

			phase('idle-end');
			await sleep(1000);
			mark('end', VARIANT);
		} finally {
			probe.stop();
			Element.prototype.setPointerCapture = capture;
			Element.prototype.releasePointerCapture = release;
			summary = probe.summarize('idle');
			running = false;
			done = true;
		}
	}

	function save() {
		log.download(`dash30-${VARIANT}.json`, {
			variant: VARIANT,
			params: Object.fromEntries(params),
			charts: charts.map((c) => c.id),
			viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
			userAgent: navigator.userAgent,
			mountedAt,
			events,
			summary,
			probe: probe?.toJSON() ?? null
		});
	}

	// --- Data ---------------------------------------------------------------

	onMount(async () => {
		try {
			const url = `${location.origin}/data/flights-200k.parquet`;
			const list = (xs) => `['${xs.join("', '")}']`;
			// Synthetic categories, deterministic per row (hash of the row id), so
			// every run draws the same dashboard. Skewed (pow) so sorted bars
			// differ in height.
			const h = (salt) => `((hash(rid, ${salt}) % 1000000) / 1e6)`;
			await queryEngine.exec(`
				CREATE TABLE dash AS
				SELECT
					delay, distance, "time",
					${list(CARRIERS)}[1 + floor(10 * pow(${h(1)}, 2))::INT] AS carrier,
					${list(AIRPORTS)}[1 + floor(20 * pow(${h(2)}, 1.6))::INT] AS origin,
					${list(AIRPORTS)}[1 + floor(20 * pow(${h(3)}, 1.6))::INT] AS dest,
					${list(MONTHS)}[1 + floor(12 * ${h(4)})::INT] AS month,
					${list(DAYS)}[1 + floor(7 * pow(${h(5)}, 1.2))::INT] AS weekday,
					CASE WHEN distance < 500 THEN 'short' WHEN distance < 1000 THEN 'medium'
						WHEN distance < 2000 THEN 'long' ELSE 'very long' END AS dist_band,
					CASE WHEN delay < 0 THEN 'early' WHEN delay < 15 THEN 'on time'
						WHEN delay < 60 THEN 'late' ELSE 'very late' END AS delay_band,
					CASE WHEN "time" < 6 THEN 'night' WHEN "time" < 12 THEN 'morning'
						WHEN "time" < 18 THEN 'afternoon' ELSE 'evening' END AS block,
					-- origin and dest are the aliases above: DuckDB resolves
					-- select-list aliases left to right.
					origin || '-' || dest AS route
				FROM (
					SELECT f.*, row_number() OVER () AS rid
					FROM read_parquet('${url}') f, range(${SCALE}) r(rep)
				)
			`);
			mountedAt = performance.now();
			isLoaded = true;
			await gpuCoordinator.ready;
			await tick();
			probe = new FrameProbe({
				mutationRoot: MUTATIONS ? dashEl : null,
				device: gpuCoordinator.device
			});
			probeReady = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});

	onDestroy(() => probe?.destroy());

	const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(d));
</script>

<svelte:head><title>Dashboard 30</title></svelte:head>

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading {(SCALE * 200).toLocaleString()}k rows…</p>
{:else}
	<div class="page">
		<header>
			<strong>Dashboard {charts.length}</strong>
			<span class="variant">{VARIANT}</span>
			<span
				class="note-old"
				title="Since the bar charts' labels became <Labels> (attached, the default), logs named dash30-labels-* are from before: they measured TextMark labels. Compare them with dash30-textmark-*."
				>dash30-labels-* logs are older TextMark runs</span
			>
			<button disabled={running || done || !probeReady} onclick={runSession}>
				{running ? 'running…' : done ? 'done (reload to rerun)' : 'Run session'}
			</button>
			<button disabled={!done} onclick={save}>Save log</button>
			{#if !probeReady}<span class="warn">waiting for the GPU…</span>{/if}
			{#if running}<span class="warn">don't move the mouse</span>{/if}
		</header>

		{#if summary}
			<table class="summary">
				<thead>
					<tr>
						<th>phase</th>
						<th>frames</th>
						<th>dt p50</th>
						<th>dt p95</th>
						<th>dt p99</th>
						<th>dt max</th>
						<th>dropped</th>
						<th>work p50</th>
						<th>work p95</th>
						<th>work max</th>
						<th>gpu p50</th>
						<th>gpu p95</th>
						<th>pass p50</th>
						<th>pass p95</th>
						<th>passes</th>
						{#if MUTATIONS}<th>mut p50</th><th>mut max</th>{/if}
						<th>atlas</th>
						<th>LoAF</th>
					</tr>
				</thead>
				<tbody>
					{#each summary.phases as p (p.phase)}
						<tr>
							<td>{p.phase}</td>
							<td>{p.frames}</td>
							<td>{fmt(p.dtP50)}</td>
							<td>{fmt(p.dtP95)}</td>
							<td>{fmt(p.dtP99)}</td>
							<td>{fmt(p.dtMax)}</td>
							<td class:bad={p.droppedPct > 5}>{p.dropped} ({fmt(p.droppedPct, 0)}%)</td>
							<td>{fmt(p.workP50)}</td>
							<td>{fmt(p.workP95)}</td>
							<td>{fmt(p.workMax)}</td>
							<td>{fmt(p.gpuP50)}</td>
							<td>{fmt(p.gpuP95)}</td>
							<td>{fmt(p.passMsP50)}</td>
							<td>{fmt(p.passMsP95)}</td>
							<td>{fmt(p.passesP50, 0)} (max {fmt(p.passesMax, 0)})</td>
							{#if MUTATIONS}<td>{fmt(p.mutationsP50, 0)}</td><td>{fmt(p.mutationsMax, 0)}</td>{/if}
							<td>{p.elementDraws} (max {p.elementDrawsMax})</td>
							<td>{p.loafs}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="note">
				ms. Cadence {fmt(summary.cadence, 2)} ms (≈{Math.round(1000 / summary.cadence)} Hz, the idle
				median). work = main thread from frame start to the end of rendering; gpu = submit to work done;
				pass = GPU time of our passes (timestamps), and passes per submit.
			</p>
		{/if}

		<div class="dash" bind:this={dashEl}>
			{#each charts as c (c.id)}
				<section data-chart={c.id}>
					<h3>{c.id}. {c.title}</h3>
					<div class="chart">
						<ChartContainer xLabel={xLabelOf(c)} yLabel={yLabelOf(c)}>
							<Frame />
							{#if AXES}<AxisLeft ticksNumber={4} /><AxisBottom ticksNumber={4} />{/if}
							{#if c.kind === 'barY'}
								<BarMarkY
									table="dash"
									x={c.cat}
									y={measureOf(c)}
									fill="steelblue"
									transforms={transformsOf(c)}
									sort={{ x: 'y', order }}
									selection="brush"
								>
									{#if ATTACHED}
										<Labels fontSize={9} format={c.measure ? fmtMean : fmtCount} />
									{/if}
								</BarMarkY>
							{:else if c.kind === 'barX'}
								<BarMarkX
									table="dash"
									x={count()}
									y={c.cat}
									fill="seagreen"
									transforms={transformsOf(c)}
									sort={{ y: 'x', order }}
									selection="brush"
								>
									{#if ATTACHED}<Labels fontSize={9} format={fmtCount} />{/if}
								</BarMarkX>
							{:else if c.kind === 'stackY'}
								<BarMarkY table="dash" x={c.cat} y={count()} fill={c.fill} selection="brush" />
							{:else if c.kind === 'hist'}
								<RectYMark
									fitDomain={false}
									table="dash"
									x={bin(c.x, c.steps ? { steps: c.steps } : {})}
									y={count()}
									inset={0.5}
									fill="steelblue"
									selection="brush"
								/>
							{:else if c.kind === 'histStack'}
								<RectYMark
									fitDomain={false}
									table="dash"
									x={bin(c.x)}
									y={count()}
									fill={c.fill}
									inset={0.5}
									transforms={[stackY()]}
									selection="brush"
								/>
							{:else if c.kind === 'line'}
								<LineMark table="dash" x={bin(c.x)} y={avg(c.y)} selection="brush" />
							{:else if c.kind === 'area'}
								<AreaMarkY
									table="dash"
									x={bin(c.x)}
									y={count()}
									fillOpacity={0.6}
									selection="brush"
								/>
							{:else if c.kind === 'areaStack'}
								<AreaMarkY
									table="dash"
									x={bin(c.x)}
									y={count()}
									fill={c.fill}
									transforms={[stackY()]}
									selection="brush"
								/>
							{:else if c.kind === 'dots'}
								<DotsMark table="dash" x={c.x} y={c.y} r={1} opacity={0.25} selection="brush" />
							{/if}
							{#if textLabelled(c)}
								{#if c.kind === 'barY'}
									<TextMark
										table="dash"
										x={c.cat}
										y={measureOf(c)}
										text={measureOf(c)}
										format={c.measure ? fmtMean : fmtCount}
										transforms={transformsOf(c)}
										dy={-6}
										fontSize={9}
										selection="brush"
									/>
								{:else if c.kind === 'barX'}
									<TextMark
										table="dash"
										x={count()}
										y={c.cat}
										text={count()}
										format={fmtCount}
										transforms={transformsOf(c)}
										textAnchor="start"
										dx={3}
										fontSize={9}
										selection="brush"
									/>
								{:else if c.kind === 'hist'}
									<TextMark
										table="dash"
										x={bin(c.x, c.steps ? { steps: c.steps } : {})}
										y={count()}
										text={count()}
										format={fmtCount}
										dy={-6}
										fontSize={8}
										selection="brush"
									/>
								{/if}
							{/if}
							{#if c.toggle}<Toggle selection="brush" field={c.cat} />{/if}
							{#if c.brush}<IntervalX selection="brush" />{/if}
						</ChartContainer>
					</div>
				</section>
			{/each}
		</div>
	</div>
{/if}

<style>
	.page {
		height: 100vh;
		display: flex;
		flex-direction: column;
		padding: 8px 12px;
		box-sizing: border-box;
		font-family: system-ui, sans-serif;
		background: var(--fjader-bg, #fff);
	}
	header {
		display: flex;
		gap: 12px;
		align-items: center;
		font-size: 13px;
		margin-bottom: 6px;
	}
	.variant {
		font-family: ui-monospace, monospace;
		color: #666;
	}
	.note-old {
		color: #888;
		font-size: 11px;
	}
	.warn {
		color: #b45309;
	}
	.summary {
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		border-collapse: collapse;
		margin-bottom: 4px;
	}
	.summary th,
	.summary td {
		padding: 1px 8px;
		text-align: right;
		border-bottom: 1px solid #eee;
	}
	.summary th:first-child,
	.summary td:first-child {
		text-align: left;
	}
	.bad {
		color: #b00020;
		font-weight: 600;
	}
	.note {
		font-size: 11px;
		color: #666;
		margin: 0 0 6px;
	}
	/* Every chart on screen at once: a chart scrolled out of view would not draw. */
	.dash {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		grid-auto-rows: minmax(0, 1fr);
		gap: 6px;
	}
	section {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	h3 {
		font-size: 11px;
		font-weight: 600;
		margin: 0 0 2px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chart {
		flex: 1;
		min-height: 0;
	}
	.status {
		padding: 1rem;
	}
	.status.error {
		color: #b00020;
	}
</style>
