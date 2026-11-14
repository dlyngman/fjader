<script>
	/**
	 * Click session: how many selection clicks reach the base table with today's
	 * code, and what they cost (categorical_enum.md, "Next step"). Copied from
	 * /test/preagg-legend, whose fixed 1M rows and 5,000-row sample stay as they
	 * are; this page adds a raw-dots chart on the full table, a row count and a
	 * scripted session.
	 *
	 *   ?rows=N             rows in the table (default 200000)
	 *   ?variant=patient    each click waits until the hover's preagg builds
	 *                       finished (the activations it started, capped at 3 s)
	 *   ?variant=eager      each click lands one frame after the hover (default)
	 *
	 * Run session, then Save log: every statement (attachQueryLog, with its
	 * source: a preagg table or the base table), and every scripted event with
	 * its time, so reads can be grouped by the click or brush move that caused
	 * them. One run per page load: reload between runs.
	 *
	 * The script fires only the events the interactors listen to: moves as
	 * pointerrawupdate where ChartCell uses it (Chrome, not in an iframe), else
	 * pointermove. setPointerCapture throws NotFoundError for a synthetic
	 * pointer id, so capture is a no-op while the session runs. Leaving a chart
	 * is scripted too (pointerleave before the next chart's pointerenter), or the
	 * chart left behind still counts as hovered.
	 */
	import { count } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		WebGPUCanvas,
		BarMarkY,
		RectYMark,
		IntervalX,
		Legend,
		DotsMark
	} from '$lib/components';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import { bin } from '$lib/sql/bin';
	import { attachQueryLog } from '$lib/query-engine/debug/query-log';

	const ROWS = Math.max(1000, Number(page.url.searchParams.get('rows')) || 200_000);
	const VARIANT = page.url.searchParams.get('variant') === 'patient' ? 'patient' : 'eager';
	const CARRIERS = ['AA', 'DL', 'UA', 'WN', 'B6', 'AS', 'NK', 'F9', 'G4', 'HA'];
	/** Waiting for a hover's builds stops here, so a stuck build cannot hang a run. */
	const BUILD_WAIT_CAP_MS = 3000;
	/** A step is settled once no mark read has been pending for this long... */
	const QUIET_MS = 150;
	/** ...or after this, whatever is still pending (recorded). */
	const SETTLE_CAP_MS = 5000;

	const { queryEngine } = initFjader();
	const log = attachQueryLog(queryEngine);
	let isLoaded = $state(false);
	let loadError = $state(null);
	let running = $state(false);
	let done = $state(false);
	let mountedAt = 0;
	/** Scripted events: hovers, clicks, brush moves, waits, in order. */
	const events = [];

	// Mark reads pending (query() with a mark's callerId), for settling between
	// steps; tooltip lookups and fits (ids with ':') are not a mark's data.
	let pendingReads = 0;
	let lastReadSettled = 0;
	const query = queryEngine.query.bind(queryEngine);
	queryEngine.query = async (sql, opts) => {
		const id = opts?.callerId;
		const mark = !!id && id !== 'tooltip' && !id.includes(':');
		if (mark) pendingReads++;
		try {
			return await query(sql, opts);
		} finally {
			if (mark) {
				pendingReads--;
				lastReadSettled = performance.now();
			}
		}
	};

	// Activations started since the last hover: a patient click waits for them.
	let activations = [];
	const activate = queryEngine.activate.bind(queryEngine);
	queryEngine.activate = (group, source) => {
		const p = activate(group, source);
		activations.push(p);
		return p;
	};

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const frame = () => new Promise((r) => requestAnimationFrame(r));
	// Server rendering has no window; the session only runs in the browser.
	const moveType =
		typeof window !== 'undefined' && 'onpointerrawupdate' in window && window.self === window.top
			? 'pointerrawupdate'
			: 'pointermove';

	function mark(kind, label, extra = {}) {
		events.push({ kind, label, time: performance.now(), ...extra });
	}

	/** Until no mark read is pending and none settled for QUIET_MS, capped. */
	async function settle(label) {
		const start = performance.now();
		await frame();
		while (performance.now() - start < SETTLE_CAP_MS) {
			if (pendingReads === 0 && performance.now() - lastReadSettled >= QUIET_MS) break;
			await sleep(10);
		}
		mark('settled', label, { pending: pendingReads, ms: performance.now() - start });
	}

	/** The variant's wait between a hover and its first click. */
	async function afterHover(label) {
		if (VARIANT === 'eager') {
			await frame();
			return;
		}
		const started = activations;
		const t0 = performance.now();
		const timedOut = await Promise.race([
			Promise.allSettled(started).then(() => false),
			sleep(BUILD_WAIT_CAP_MS).then(() => true)
		]);
		mark('builds', label, {
			activations: started.length,
			ms: performance.now() - t0,
			timedOut
		});
	}

	const chartEl = (name) => document.querySelector(`[data-chart="${name}"]`);
	const foreground = (name) => chartEl(name)?.querySelector('svg.svg-foreground');

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

	/** The chart the scripted pointer is on, if any. */
	let hovered = null;

	/**
	 * Leave the chart the pointer is on: its plot surface, then its cell. A real
	 * pointer always does before entering another chart. Without it the chart
	 * still counts as hovered, and its hover settle re-runs its activators
	 * (HoverSettle, 200 ms after a click) as a new batch, which drops the next
	 * chart's queued builds.
	 */
	function leaveChart() {
		if (!hovered) return;
		const svg = foreground(hovered);
		const r = svg.getBoundingClientRect();
		mark('leave', hovered);
		pointer(svg, 'pointerleave', r.right + 1, r.top - 1);
		pointer(svg.closest('.chart-cell'), 'pointerleave', r.right + 1, r.top - 1);
		hovered = null;
	}

	/** Enter a chart: its cell, then its plot surface, as a real pointer would. */
	function hoverChart(name) {
		leaveChart();
		hovered = name;
		const svg = foreground(name);
		const r = svg.getBoundingClientRect();
		const x = r.left + r.width / 2;
		const y = r.top + r.height / 2;
		activations = [];
		mark('hover', name);
		pointer(svg.closest('.chart-cell'), 'pointerenter', x, y);
		pointer(svg, 'pointerenter', x, y);
	}

	function hoverLegend(name) {
		leaveChart();
		const el = chartEl(name).querySelector('.legend-ordinal');
		const r = el.getBoundingClientRect();
		activations = [];
		mark('hover', `${name} legend`);
		pointer(el, 'pointerenter', r.left + 4, r.top + 4);
	}

	function clickLegend(name, value, shift = false) {
		const item = [...chartEl(name).querySelectorAll('.legend-item-interactive')].find(
			(b) => b.textContent.trim() === value
		);
		mark('click', `legend ${value}${shift ? ' (shift)' : ''}`);
		item.dispatchEvent(
			new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: shift })
		);
	}

	/** A click on a band axis label: Toggle's margin path, no tooltip hit needed. */
	function clickAxisLabel(name, value, shift = false) {
		const label = [...chartEl(name).querySelectorAll('text')].find(
			(t) => t.textContent.trim() === value
		);
		const r = label.getBoundingClientRect();
		mark('click', `toggle ${value}${shift ? ' (shift)' : ''}`);
		foreground(name).dispatchEvent(
			new MouseEvent('click', {
				bubbles: true,
				cancelable: true,
				shiftKey: shift,
				clientX: r.left + r.width / 2,
				clientY: r.top + r.height / 2
			})
		);
	}

	/** A brush drag across the histogram, one move per frame, then release. */
	async function brush(name, ms) {
		const svg = foreground(name);
		const r = svg.getBoundingClientRect();
		const y = r.top + r.height * 0.5;
		const at = (f) => r.left + r.width * f;
		// Each event is marked before it is dispatched: reads it asks for
		// synchronously must not look older than the event.
		mark('down', name);
		pointer(svg, 'pointerdown', at(0.3), y, 1);
		const start = performance.now();
		for (;;) {
			await frame();
			const t = (performance.now() - start) / ms;
			if (t >= 1) break;
			const f = 0.3 + 0.3 * (t < 0.5 ? t * 2 : 2 - t * 2) + 0.1 * t;
			mark('move', name);
			pointer(svg, moveType, at(f), y, 1);
		}
		mark('up', name);
		pointer(svg, 'pointerup', at(0.4), y, 0);
	}

	/** A press without a move: clears the brush. */
	function clearBrush(name) {
		const svg = foreground(name);
		const r = svg.getBoundingClientRect();
		const x = r.left + r.width * 0.5;
		const y = r.top + r.height * 0.5;
		mark('click', `${name} clear brush`);
		pointer(svg, 'pointerdown', x, y, 1);
		pointer(svg, 'pointerup', x, y, 0);
	}

	async function runSession() {
		running = true;
		const capture = Element.prototype.setPointerCapture;
		const release = Element.prototype.releasePointerCapture;
		Element.prototype.setPointerCapture = function (id) {
			try {
				capture.call(this, id);
			} catch {
				// NotFoundError: no such active pointer (a synthetic id).
			}
		};
		Element.prototype.releasePointerCapture = function (id) {
			try {
				release.call(this, id);
			} catch {
				// As above.
			}
		};
		try {
			await settle('start');
			mark('session', VARIANT, { rows: ROWS });

			// Legend clicks on the carrier legend.
			hoverLegend('carrier');
			await afterHover('carrier legend');
			clickLegend('carrier', 'UA');
			await settle('legend UA');
			clickLegend('carrier', 'DL', true);
			await settle('legend DL');
			clickLegend('carrier', 'WN');
			await settle('legend WN');

			// Toggle clicks on the bars' band axis labels.
			hoverChart('carrier');
			await afterHover('carrier chart');
			clickAxisLabel('carrier', 'AA');
			await settle('toggle AA');
			clickAxisLabel('carrier', 'B6', true);
			await settle('toggle B6');

			// A brush on the delay histogram, then clear it.
			hoverChart('delay');
			await afterHover('delay chart');
			await brush('delay', 1500);
			await settle('brush');
			clearBrush('delay');
			await settle('clear brush');
			leaveChart();
			mark('end', VARIANT);
		} finally {
			Element.prototype.setPointerCapture = capture;
			Element.prototype.releasePointerCapture = release;
			running = false;
			done = true;
		}
	}

	function save() {
		const tag = ROWS >= 1_000_000 ? `${ROWS / 1_000_000}m` : `${ROWS / 1000}k`;
		log.download(`clog-${tag}-${VARIANT}.json`, {
			rows: ROWS,
			variant: VARIANT,
			moveType,
			mountedAt,
			events
		});
	}

	onMount(async () => {
		try {
			const url = `${window.location.origin}/data/flights-200k.parquet`;
			const carriers = `['${CARRIERS.join("', '")}']`;
			await queryEngine.exec(`
				CREATE TABLE preagg_flights AS
				SELECT (delay + (rep % 11) - 5)::SMALLINT AS delay,
				       (distance + (rep % 13) * 3)::SMALLINT AS distance,
				       "time",
				       ${carriers}[1 + floor(10 * pow((hash(rid, rep) % 1000000) / 1e6, 2))::INT] AS carrier
				FROM (SELECT *, row_number() OVER () AS rid FROM read_parquet('${url}')) base,
				     range(${Math.ceil(ROWS / 200_000)}) r(rep)
				LIMIT ${ROWS}
			`);
			mountedAt = performance.now();
			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading {ROWS.toLocaleString()} rows…</p>
{:else}
	<div class="container">
		<h1>Click session</h1>
		<p class="lede">
			{ROWS.toLocaleString()} rows, variant <b>{VARIANT}</b>
			({VARIANT === 'patient'
				? "each click waits for its hover's preagg builds"
				: 'each click lands one frame after its hover'}). Press Run session without touching the
			mouse, then Save log. Reload between runs.
		</p>
		<p class="controls">
			<button disabled={running || done} onclick={runSession}>
				{running ? 'running…' : done ? 'done' : 'Run session'}
			</button>
			<button disabled={running} onclick={save}>Save log</button>
			{#if running}<span>don't move the mouse</span>{/if}
		</p>

		<div class="grid">
			<div class="panel" data-chart="delay">
				<h3>Delay (brush)</h3>
				<ChartContainer xLabel="delay" yLabel="count">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<RectYMark
									table="preagg_flights"
									x={bin('delay', { steps: 50 })}
									y={count()}
									inset={0.5}
									fill="steelblue"
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet interactors()}<IntervalX selection="brush" />{/snippet}
				</ChartContainer>
			</div>

			<div class="panel" data-chart="carrier">
				<h3>Carrier (Toggle and legend)</h3>
				<ChartContainer xLabel="carrier" yLabel="count" legendPosition="top">
					{#snippet legend()}<Legend color="carrier" selection="brush" />{/snippet}
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<BarMarkY
									table="preagg_flights"
									x="carrier"
									y={count()}
									fill="carrier"
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet interactors()}<Toggle selection="brush" field="carrier" />{/snippet}
				</ChartContainer>
			</div>

			<div class="panel" data-chart="delay-by-carrier">
				<h3>Delay by carrier (selectionResponse="filter")</h3>
				<ChartContainer xLabel="delay" yLabel="count">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<RectYMark
									table="preagg_flights"
									x={bin('delay', { steps: 50 })}
									y={count()}
									inset={0.5}
									fill="carrier"
									selection="brush"
									selectionResponse="filter"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>

			<div class="panel" data-chart="distance">
				<h3>Distance (filtered)</h3>
				<ChartContainer xLabel="distance" yLabel="count">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<RectYMark
									table="preagg_flights"
									x={bin('distance', { steps: 50 })}
									y={count()}
									inset={0.5}
									fill="seagreen"
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>

			<div class="panel" data-chart="dots">
				<h3>Delay by distance (every row; filtered)</h3>
				<ChartContainer xLabel="distance" yLabel="delay">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<DotsMark
									table="preagg_flights"
									x="distance"
									y="delay"
									r={1}
									opacity={0.3}
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>
{/if}

<style>
	.container {
		max-width: 1300px;
		margin: 0 auto;
		padding: 24px 16px;
	}
	.lede {
		color: #555;
		max-width: 80ch;
	}
	.controls {
		display: flex;
		gap: 12px;
		align-items: center;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
		gap: 16px;
	}
	.panel {
		height: 320px;
	}
	.status.error {
		color: #b00020;
	}
</style>
