<script>
	/**
	 * Rebin session: what a binned, stacked time histogram's y axis does when
	 * zooming re-buckets it (LOD), scripted so every run is the same.
	 *
	 *   ?fit=0       no fitDomain: y from the whole result, not the window
	 *   ?overlay=1   a rule at a fixed y on the same scale (it snaps with its tick)
	 *   ?overlay=line  a line of data at that level instead: a data layer, which
	 *                keeps the spring
	 *   ?overlay=labels  count labels on the bars (TextMark, the same bins; use with
	 *                fit=0: TextMark has no fitDomain, so its whole-result extent
	 *                would hold a fitted y up): a
	 *                data layer too, which rebins on its own query; the table
	 *                adds how long the labels lag the bars' rebin
	 *   ?sparse=1    group c only in the burst week: past the dense row limit
	 *                the rows are not the dense layout, and the fit is queried
	 *
	 * Run session, wait for the table, then Save log (rebin-<variant>.json in
	 * Downloads). One run per page load: reload between runs.
	 *
	 * The script: zoom-ins toward the burst week (mid 2024), with three probe
	 * rounds among them (a zoom just past the rebin threshold, which often
	 * keeps its nice step, then a pan off the burst and back), four pans,
	 * shift+scroll finer then coarser, six zoom-outs.
	 * Zooms and pans are in the x axis margin, so they move x only, as a user
	 * zooming the time axis; inside the plot they would zoom y too, and a y the
	 * user zoomed is never refitted. Events are dispatched on the chart's own
	 * elements, so they go through its real wheel and pan handlers.
	 *
	 * What it records:
	 * - every read of the histogram, cached or not (a wrapper on
	 *   queryEngine.query: a zoom back to a step queried before is answered from
	 *   the query cache and sends no statement), with its first bin's width;
	 * - every domain transition (snap or spring);
	 * - every rendered frame: the drawn x and y domains and the tallest stack in
	 *   view, as a fraction of the plot's height.
	 *
	 * A rebin is a read whose bin width changed (as the mark decides it). Per
	 * rebin the table shows the y transitions it caused and the tallest bar's
	 * height: before, lowest in the next 600 ms, and settled. Expected:
	 * - fitDomain or plain, alone or with the rule: one y snap, no spring;
	 *   lowest ≈ settled (no duck). The rule moves with its tick.
	 * - with the line: one y spring, no snap; the bars may dip and recover while
	 *   y springs (the gate keeps the line, a data layer, from jumping).
	 * - no SQL fit queries: a binned mark fits from its result.
	 */
	import { page } from '$app/state';
	import { count } from '@uwdata/mosaic-sql';
	import { initFjader, stackY } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		RectYMark,
		RuleMarkY,
		LineMark,
		TextMark
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import { bin } from '$lib/sql/bin';
	import { attachQueryLog } from '$lib/query-engine/debug/query-log';
	import { binLayout } from '$lib/components/marks/lifecycle/bin-layout';
	import { windowedFit } from '$lib/components/marks/lifecycle/fit-domain';

	const fit = page.url.searchParams.get('fit') !== '0';
	const overlayParam = page.url.searchParams.get('overlay');
	/** null, 'rule' (?overlay=1), 'line' or 'labels' (?overlay=line, ?overlay=labels). */
	const overlay =
		overlayParam === 'line' || overlayParam === 'labels'
			? overlayParam
			: overlayParam
				? 'rule'
				: null;
	const sparse = page.url.searchParams.get('sparse') === '1';
	const TAG = `${fit ? 'fit' : 'plain'}${overlay ? `-${overlay}` : ''}${sparse ? '-sparse' : ''}`;
	/** A variant's query string; `o` is null, 'rule' or 'line'. */
	const variant = (f, o = null, s = false) =>
		'?' +
		[f ? '' : 'fit=0', o === 'rule' ? 'overlay=1' : o ? `overlay=${o}` : '', s ? 'sparse=1' : '']
			.filter(Boolean)
			.join('&');
	/** A rule follows its tick, so it snaps with the axis; data layers (a line, labels) keep the spring. */
	const expectSnap = overlay !== 'line' && overlay !== 'labels';

	/**
	 * The page's own rebin test: a first-bin width change past this ratio. The
	 * mark compares the bin spec its result was computed from, which the page
	 * cannot see; for this page's automatic steps (at least 1.5 apart) the two
	 * agree.
	 */
	const REBIN_RATIO = 1.25;
	/** A step is settled once nothing has happened for this long... */
	const QUIET_MS = 700;
	/** ...or after this. */
	const SETTLE_CAP_MS = 5000;
	/** How long after a rebin its y transitions and its lowest bar are looked for. */
	const AFTER_MS = 600;
	/** Same-step zoom probes: a zoom just past the threshold, then a pan off and back. */
	const PROBE_ROUNDS = 3;

	const { queryEngine, gpuCoordinator } = initFjader();
	const qlog = attachQueryLog(queryEngine);
	const t0 = performance.now();
	const now = () => Math.round((performance.now() - t0) * 10) / 10;

	let isLoaded = $state(false);
	let loadError = $state(null);
	let running = $state(false);
	let done = $state(false);
	let rows = $state([]);
	let summary = $state(null);
	let probes = $state([]);
	let chartEl = $state();

	/** Scripted events, in order. */
	const events = [];
	/** Every read of the histogram: time, interval, first bin width, rows. */
	const reads = [];
	/** SQL fit queries of the histogram (expected: none). */
	const fits = [];
	/** Every read of the labels (?overlay=labels): time and bin interval. */
	const labelReads = [];
	/** Domain transitions. */
	const transitions = [];
	/** Rendered frames while the session runs. */
	const frames = [];
	let lastActivity = 0;
	let pendingReads = 0;
	let recording = false;

	// The latest result, for the per-frame probe.
	let latest = null;

	// --- Reads, cached or not -------------------------------------------------
	const query = queryEngine.query.bind(queryEngine);
	queryEngine.query = async (sql, opts) => {
		const id = opts?.callerId ?? '';
		const histogram = id.startsWith('recty');
		const data = histogram && !id.includes(':');
		const labels = id.startsWith('text') && !id.includes(':');
		if (histogram && id.endsWith(':fitDomain')) fits.push({ t: now() });
		if (data) pendingReads++;
		try {
			const table = await query(sql, opts);
			if (data) noteResult(sql, table);
			if (labels) labelReads.push({ t: now(), interval: intervalOf(sql) });
			return table;
		} finally {
			if (data) {
				pendingReads--;
				lastActivity = performance.now();
			}
		}
	};

	/** A time bin's interval from its SQL, e.g. '1 day'. */
	const intervalOf = (sql) => sql.match(/INTERVAL\s*'?([^)',]+)'?/i)?.[1]?.trim() ?? '?';

	function noteResult(sql, table) {
		const x1 = table.getChild('x1')?.toArray();
		const x2 = table.getChild('x2')?.toArray();
		const y1 = table.getChild('y1')?.toArray();
		if (!x1 || !x2 || !y1 || table.numRows === 0) return;
		const interval = intervalOf(sql);
		reads.push({ t: now(), interval, width: x2[0] - x1[0], rows: table.numRows });
		latest = { x1, x2, y1, n: table.numRows, layout: binLayout(x1, table.numRows) };
	}

	// --- Per-frame probe ------------------------------------------------------
	/** The tallest stack top in the x window, from the latest result. */
	function tallestInView(x) {
		if (!latest) return null;
		const { x1, x2, y1, n, layout } = latest;
		if (layout) return windowedFit(x1, x2, layout, [y1], x)?.[1] ?? null;
		let hi = -Infinity;
		for (let i = 0; i < n; i++) if (x2[i] >= x[0] && x1[i] <= x[1] && y1[i] > hi) hi = y1[i];
		return hi > -Infinity ? hi : null;
	}

	function onFrame() {
		if (!recording) return;
		const scales = gpuCoordinator.debugScales();
		const xs = scales.find((s) => s.type === 'time' && s.domain && !s.destroyed);
		const ys = scales.find((s) => s.type === 'linear' && s.domain && !s.destroyed);
		if (!xs || !ys) return;
		const [y0, y1] = ys.domain;
		const top = tallestInView(xs.domain);
		frames.push({
			t: now(),
			x: xs.domain,
			y: ys.domain,
			frac: top == null || y1 <= y0 ? null : (top - y0) / (y1 - y0)
		});
	}

	// --- Scripted pointer -----------------------------------------------------
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const frame = () => new Promise((r) => requestAnimationFrame(r));
	const moveType =
		typeof window !== 'undefined' && 'onpointerrawupdate' in window && window.self === window.top
			? 'pointerrawupdate'
			: 'pointermove';

	const foreground = () => chartEl.querySelector('svg.svg-foreground');
	const plot = () => chartEl.querySelector('g.frame').getBoundingClientRect();
	/** A point in the x axis margin, `f` of the way across the plot. */
	function marginPoint(f) {
		const r = plot();
		return [r.left + r.width * f, r.bottom + 12];
	}

	function mark(kind, label) {
		events.push({ kind, label, t: now() });
	}

	function pointer(target, type, x, y, buttons = 0) {
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
				clientY: y
			})
		);
	}

	function wheel(f, deltaY, shiftKey = false) {
		const [x, y] = marginPoint(f);
		foreground().dispatchEvent(
			new WheelEvent('wheel', {
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				deltaY,
				shiftKey
			})
		);
	}

	/** Enter the chart and dwell, as the wheel handler requires before it zooms. */
	async function enter() {
		const [x, y] = marginPoint(0.5);
		mark('enter', 'chart');
		pointer(foreground().closest('.chart-cell'), 'pointerenter', x, y);
		pointer(foreground(), 'pointerenter', x, y);
		await sleep(400);
	}

	function leave() {
		const r = foreground().getBoundingClientRect();
		mark('leave', 'chart');
		pointer(foreground(), 'pointerleave', r.right + 1, r.top - 1);
		pointer(foreground().closest('.chart-cell'), 'pointerleave', r.right + 1, r.top - 1);
	}

	/** Wheel notches at `f`, one per frame. In: deltaY < 0 (×1.25 per notch). */
	async function zoom(label, f, notches, deltaY, shiftKey = false) {
		mark('gesture', label);
		for (let i = 0; i < notches; i++) {
			wheel(f, deltaY, shiftKey);
			await frame();
		}
		// The quiet wait counts from here: a gesture sends no read itself, and
		// the fit after it is debounced (200 ms).
		lastActivity = performance.now();
	}

	/** A drag in the x margin from `from` to `to` (fractions of the plot), over `ms`. */
	async function pan(label, from, to, ms = 500) {
		mark('gesture', label);
		const svg = foreground();
		const [x0, y] = marginPoint(from);
		const [x1] = marginPoint(to);
		pointer(svg, 'pointerdown', x0, y, 1);
		const start = performance.now();
		for (;;) {
			await frame();
			const t = Math.min(1, (performance.now() - start) / ms);
			pointer(svg, moveType, x0 + (x1 - x0) * t, y, 1);
			if (t >= 1) break;
		}
		pointer(svg, 'pointerup', x1, y, 0);
		lastActivity = performance.now();
	}

	/** Until no read is pending and nothing has happened for QUIET_MS, capped. */
	async function settle(label) {
		const start = performance.now();
		await frame();
		while (performance.now() - start < SETTLE_CAP_MS) {
			const quiet = performance.now() - lastActivity >= QUIET_MS;
			if (pendingReads === 0 && quiet) break;
			await sleep(20);
		}
		mark('settled', label);
	}

	async function runSession() {
		running = true;
		recording = true;
		const capture = Element.prototype.setPointerCapture;
		const release = Element.prototype.releasePointerCapture;
		// A synthetic pointer id has no active pointer to capture.
		Element.prototype.setPointerCapture = function (id) {
			try {
				capture.call(this, id);
			} catch {
				// NotFoundError
			}
		};
		Element.prototype.releasePointerCapture = function (id) {
			try {
				release.call(this, id);
			} catch {
				// NotFoundError
			}
		};
		try {
			await settle('start');
			await enter();
			// Toward the burst week (~72% across the full extent): the zoom keeps
			// the point under the pointer, so it stays there.
			for (let i = 1; i <= 3; i++) {
				await zoom(`zoom in ${i}`, 0.72, 3, -100);
				await settle(`zoom in ${i}`);
			}
			// Same-step zooms: two notches (×1.56) cross the rebin threshold (1.5)
			// but often land on the same nice step, whose query is the same and
			// is answered with the same table, so no result reaches the mark.
			// The pans after it must still refit y (fitDomain).
			for (let i = 1; i <= PROBE_ROUNDS; i++) {
				await zoom(`probe zoom ${i}`, 0.72, 2, -100);
				await settle(`probe zoom ${i}`);
				await pan(`probe pan off ${i}`, 0.3, 0.9);
				await settle(`probe pan off ${i}`);
				await pan(`probe pan back ${i}`, 0.9, 0.3);
				await settle(`probe pan back ${i}`);
			}
			// To the same depth as without the probe (six zoom-ins of three notches).
			await zoom('zoom in 4', 0.72, 3, -100);
			await settle('zoom in 4');
			// Off the burst and back: x moves, the bins stay.
			await pan('pan 1', 0.3, 0.9);
			await settle('pan 1');
			await pan('pan 2', 0.3, 0.9);
			await settle('pan 2');
			await pan('pan 3', 0.9, 0.3);
			await settle('pan 3');
			await pan('pan 4', 0.9, 0.3);
			await settle('pan 4');
			// The bins change, x does not.
			// The multiplier compounds 3.5% a notch: 24 notches (×2.3) cross a
			// nice step for sure (at 12 h, to 6 h: past the dense row limit).
			await zoom('finer', 0.5, 24, -100, true);
			await settle('finer');
			await zoom('coarser', 0.5, 24, 100, true);
			await settle('coarser');
			for (let i = 1; i <= 6; i++) {
				await zoom(`zoom out ${i}`, 0.5, 3, 100);
				await settle(`zoom out ${i}`);
			}
			leave();
			mark('end', TAG);
		} finally {
			Element.prototype.setPointerCapture = capture;
			Element.prototype.releasePointerCapture = release;
			recording = false;
			running = false;
			done = true;
			analyse();
		}
	}

	// --- Analysis -------------------------------------------------------------
	const yTransition = (tr) => tr.part === 'domain' && tr.label !== 'ts';
	const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
	function human(seconds) {
		const units = [
			[365 * 86400, 'y'],
			[28 * 86400, 'mo'],
			[86400, 'd'],
			[3600, 'h'],
			[60, 'min']
		];
		for (const [s, u] of units) if (seconds >= s * 0.95) return `${+(seconds / s).toFixed(1)} ${u}`;
		return `${seconds} s`;
	}

	function analyse() {
		// Rebins first: a window closes at the next rebin, not the next read (a
		// result is often read twice at once, and shift+scroll re-reads it).
		const rebins = [];
		for (let i = 1; i < reads.length; i++) {
			const ratio = reads[i].width / reads[i - 1].width;
			if (ratio > REBIN_RATIO || ratio < 1 / REBIN_RATIO) rebins.push([reads[i - 1], reads[i]]);
		}
		const out = [];
		for (let i = 0; i < rebins.length; i++) {
			const [prev, r] = rebins[i];
			const next = rebins[i + 1]?.[1].t ?? Infinity;
			const end = Math.min(r.t + AFTER_MS, next);
			const ys = transitions.filter((tr) => yTransition(tr) && tr.t >= r.t - 5 && tr.t < end);
			const before = [...frames].reverse().find((f) => f.t < r.t && f.frac != null);
			const after = frames.filter((f) => f.t >= r.t && f.t < end && f.frac != null);
			const lowest = after.length ? Math.min(...after.map((f) => f.frac)) : null;
			// Settled: the last frame before the next gesture (or rebin), which
			// a fixed delay could land inside of, before that gesture's fit.
			const nextGesture = events.find((e) => e.kind === 'gesture' && e.t > r.t)?.t ?? Infinity;
			const settledAt = Math.min(r.t + 1500, next, nextGesture);
			const settled = [...frames].reverse().find((f) => f.t < settledAt && f.frac != null);
			// The labels' own result at the new interval: until it lands they
			// show the old bins' counts, placed under the new y.
			const labelsAt = labelReads.find((l) => l.t >= r.t - 5 && l.interval === r.interval)?.t;
			out.push({
				t: r.t,
				step: `${human(prev.width)} → ${human(r.width)}`,
				snaps: ys.filter((tr) => tr.snap).length,
				springs: ys.filter((tr) => !tr.snap).length,
				before: before?.frac ?? null,
				lowest,
				settled: settled?.frac ?? null,
				labelLag: labelsAt == null ? null : Math.round(labelsAt - r.t)
			});
		}
		rows = out;
		const one = out.filter((r) =>
			expectSnap ? r.snaps === 1 && r.springs === 0 : r.springs === 1 && r.snaps === 0
		).length;
		const ducks = out.filter(
			(r) =>
				r.before != null &&
				r.lowest != null &&
				r.settled != null &&
				r.lowest < 0.8 * Math.min(r.before, r.settled)
		).length;
		summary = {
			rebins: out.length,
			expected: expectSnap ? 'one y snap, no spring' : 'one y spring, no snap',
			asExpected: one,
			ducks,
			fits: fits.length,
			reads: reads.length
		};
		probes = analyseProbes();
	}

	/**
	 * Per probe round: whether its zoom asked for bins (a read) and kept the
	 * step (every read the width of the one before), the y transitions each
	 * pan after it caused, and where the tallest bar settled. A pan between
	 * two quiet stretches has nothing to refit, so transitions alone say
	 * little; the verdict is that y fits the window once the pan settles: the
	 * tallest bar between 50% and 100% of the plot. A fit held off by a stale
	 * flag leaves it above 100% (onto the burst) or collapsed (off it).
	 */
	function analyseProbes() {
		const at = (label) => events.find((e) => e.kind === 'gesture' && e.label === label)?.t;
		const out = [];
		for (let i = 1; i <= PROBE_ROUNDS; i++) {
			const tz = at(`probe zoom ${i}`);
			const tOff = at(`probe pan off ${i}`);
			const tBack = at(`probe pan back ${i}`);
			if (tz == null || tOff == null || tBack == null) continue;
			const tNext = events.find((e) => e.kind === 'gesture' && e.t > tBack)?.t ?? Infinity;
			const before = [...reads].reverse().find((r) => r.t < tz);
			const during = reads.filter((r) => r.t >= tz && r.t < tOff);
			const keptStep = during.length > 0 && during.every((r) => r.width === before?.width);
			const yIn = (a, b) => transitions.filter((tr) => yTransition(tr) && tr.t >= a && tr.t < b);
			const settledBefore = (t) =>
				[...frames].reverse().find((f) => f.t < t && f.frac != null)?.frac ?? null;
			const offFrac = settledBefore(tBack);
			const backFrac = settledBefore(tNext);
			const fits = (v) => v != null && v >= 0.5 && v <= 1.0001;
			out.push({
				round: i,
				reads: during.length,
				step: during.length ? human(during[during.length - 1].width) : '–',
				keptStep,
				off: yIn(tOff, tBack).length,
				back: yIn(tBack, tNext).length,
				offFrac,
				backFrac,
				follows: fits(offFrac) && fits(backFrac)
			});
		}
		return out;
	}

	function save() {
		qlog.download(`rebin-${TAG}.json`, {
			variant: { fit, overlay, sparse },
			moveType,
			events,
			reads,
			fits,
			labelReads,
			transitions,
			frames,
			rebins: rows,
			probes,
			summary
		});
	}

	onMount(() => {
		const offTransitions = gpuCoordinator.observeTransitions((rec) => {
			transitions.push({ t: now(), part: rec.part, label: rec.label, snap: rec.snap });
			lastActivity = performance.now();
		});
		gpuCoordinator.addFrameCallback(onFrame);

		(async () => {
			try {
				// Three groups, hourly-ish events over 2023–2024, with a dense
				// one-week burst in mid 2024 so zoom changes the stack's peak.
				// ?sparse=1: group c only in the burst week, so past the dense row
				// limit the rows outside it hold two series, not three.
				const background = sparse ? `['a', 'b']` : `['a', 'b', 'c']`;
				await queryEngine.exec(`
					CREATE TABLE events AS
					SELECT
						TIMESTAMP '2023-01-01' + to_seconds(CAST(floor(random() * 63072000) AS BIGINT)) AS ts,
						${background}[1 + CAST(floor(random() * len(${background})) AS INTEGER)] AS grp
					FROM range(200000)
					UNION ALL
					SELECT
						TIMESTAMP '2024-06-10' + to_seconds(CAST(floor(random() * 604800) AS BIGINT)) AS ts,
						['a', 'b', 'c'][1 + CAST(floor(random() * 3) AS INTEGER)] AS grp
					FROM range(20000)
				`);
				// The overlays' level: a rule at 300 events, or a line of data
				// at 300 across the whole range.
				await queryEngine.exec(`CREATE TABLE rule_level AS SELECT 300.0 AS v`);
				await queryEngine.exec(`
					CREATE TABLE line_level AS
					SELECT * FROM (VALUES
						(TIMESTAMP '2023-01-01', 300.0),
						(TIMESTAMP '2024-12-31', 300.0)
					) t(ts, v)
				`);
				isLoaded = true;
			} catch (error) {
				console.error('Initialization error:', error);
				loadError = error.message;
			}
		})();

		return () => {
			offTransitions();
			gpuCoordinator.removeFrameCallback(onFrame);
			queryEngine.query = query;
		};
	});
</script>

{#if loadError}
	<div class="status error">Error: {loadError}</div>
{:else if !isLoaded}
	<div class="status">Generating data...</div>
{:else}
	<div class="container">
		<h1>
			Rebin session: {fit ? 'fitDomain' : 'plain'} stacked time histogram{overlay
				? `, with a ${overlay}`
				: ''}
		</h1>
		<p class="variants">
			<a href={variant(true)}>fitDomain</a> ·
			<a href={variant(false)}>plain</a> ·
			<a href={variant(true, 'rule')}>fitDomain + rule</a> ·
			<a href={variant(false, 'rule')}>plain + rule</a> ·
			<a href={variant(true, 'line')}>fitDomain + line</a> ·
			<a href={variant(false, 'labels')}>plain + labels</a> ·
			<a href={variant(true, null, true)}>fitDomain, sparse</a>
		</p>
		{#if sparse}
			<p class="lede">
				Sparse: group c only in the burst week. Once the bins pass the dense row limit (shift+scroll
				finer, to 6 h), the rows are not the dense layout, the fit is queried (SQL fit queries &gt;
				0), and that rebin springs once without the bars collapsing first.
			</p>
		{/if}
		<p class="lede">
			Run session drives zooms, pans and shift+scroll through the chart. Hands off until the table
			appears. Expected per rebin: {expectSnap
				? `one y snap, no spring, and no dip in bar height${overlay === 'rule' ? '; the rule moves with its tick' : ''}.`
				: `one y spring, no snap (the ${overlay === 'labels' ? 'labels are' : 'line is'} a data layer).`}
		</p>
		<div class="controls">
			<button disabled={running || done} onclick={runSession}>
				{running ? 'Running…' : done ? 'Done (reload to rerun)' : 'Run session'}
			</button>
			<button disabled={!done} onclick={save}>Save log</button>
		</div>

		<div class="panel" bind:this={chartEl}>
			<ChartContainer xLabel="ts" yLabel="events">
				{#snippet background()}
					<Frame />
					<AxisLeft />
					<AxisBottom />
					<MarginLabel />
				{/snippet}
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<RectYMark
								table="events"
								x={bin('ts')}
								y={count()}
								fill="grp"
								inset={0.5}
								transforms={[stackY()]}
								fitDomain={fit ? 'y' : undefined}
							/>
							{#if overlay === 'rule'}
								<RuleMarkY table="rule_level" y="v" stroke="#c00" strokeWidth={2} />
							{:else if overlay === 'line'}
								<LineMark table="line_level" x="ts" y="v" stroke="#c00" strokeWidth={2} />
							{:else if overlay === 'labels'}
								<TextMark
									table="events"
									x={bin('ts')}
									y={count()}
									text={count()}
									dy={-6}
									fontSize={10}
								/>
							{/if}
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
			</ChartContainer>
		</div>

		{#if summary}
			<p class="summary">
				{summary.rebins} rebins in {summary.reads} reads. Expected per rebin: {summary.expected}. As
				expected: <strong>{summary.asExpected} / {summary.rebins}</strong>. Dips below 80% of the
				bar height: <strong>{summary.ducks}</strong>. SQL fit queries:
				<strong>{summary.fits}</strong>.
			</p>
			<table>
				<thead>
					<tr>
						<th>t (ms)</th>
						<th>bin step</th>
						<th>y snaps</th>
						<th>y springs</th>
						<th>tallest bar: before</th>
						<th>lowest</th>
						<th>settled</th>
						{#if overlay === 'labels'}<th>labels lag (ms)</th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.t)}
						<tr>
							<td>{Math.round(r.t)}</td>
							<td>{r.step}</td>
							<td>{r.snaps}</td>
							<td>{r.springs}</td>
							<td>{pct(r.before)}</td>
							<td>{pct(r.lowest)}</td>
							<td>{pct(r.settled)}</td>
							{#if overlay === 'labels'}<td>{r.labelLag ?? '–'}</td>{/if}
						</tr>
					{/each}
				</tbody>
			</table>

			<h3>Zoom just past the threshold, then pan</h3>
			<p class="lede">
				{fit
					? 'After each pan y must fit the window: the tallest bar settled between 50% and 100%, also after a zoom that kept its step. (A pan between two quiet stretches has nothing to refit, so it may show no transition.)'
					: 'Without fitDomain, y is the whole result’s: pans move nothing on y (0 expected).'}
			</p>
			<table>
				<thead>
					<tr>
						<th>round</th>
						<th>reads</th>
						<th>step</th>
						<th>kept step</th>
						<th>y transitions: pan off</th>
						<th>pan back</th>
						<th>tallest bar after: pan off</th>
						<th>pan back</th>
						<th>y follows</th>
					</tr>
				</thead>
				<tbody>
					{#each probes as p (p.round)}
						<tr>
							<td>{p.round}</td>
							<td>{p.reads}</td>
							<td>{p.step}</td>
							<td>{p.keptStep ? 'yes' : 'no'}</td>
							<td>{p.off}</td>
							<td>{p.back}</td>
							<td>{pct(p.offFrac)}</td>
							<td>{pct(p.backFrac)}</td>
							<td>{fit ? (p.follows ? 'yes' : 'NO') : '–'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
{/if}

<style>
	.container {
		padding: 20px;
	}
	.status {
		padding: 2rem;
	}
	.error {
		color: #c00;
	}
	.lede {
		max-width: 70ch;
		color: #555;
	}
	.controls {
		display: flex;
		gap: 8px;
		margin: 8px 0 16px;
	}
	.panel {
		height: 420px;
	}
	.summary {
		margin-top: 16px;
	}
	table {
		border-collapse: collapse;
		font:
			12px ui-monospace,
			monospace;
	}
	th,
	td {
		padding: 2px 10px;
		text-align: right;
		border-bottom: 1px solid #eee;
	}
</style>
