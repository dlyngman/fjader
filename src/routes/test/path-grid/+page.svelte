<script>
	/**
	 * Lines and areas over a binned axis with a series: a padded result, whose
	 * rows come back bin by bin with the series interleaved (a grid), not series
	 * by series (runs). Each case says what should be seen.
	 *
	 * Before the path renderers could address a grid, cases 1 to 4 drew nothing
	 * (areas: no fill; lines: nothing at all), with no error.
	 *
	 * The two charts at the top filter every case (selection "pg"): a brush on
	 * distance and a toggle on the reach (the distance band, as a field no case draws). Under them a case's values
	 * TRAVEL to the new result instead of jumping, where its rows are a grid.
	 *
	 * The console says nothing for these. An error starting "fjader: … draws
	 * nothing" means a result was padded and its rows did not check out.
	 *
	 *   ?capture=1   adds "Save captures": a scripted sequence of states (load,
	 *                two brushes, cleared, a toggle, cleared, fine bins, zoomed
	 *                in), and in each a readback of every case's canvases once
	 *                they are at rest. Saved as captures-pathgrid.json, for
	 *                scripts/measure/captures.py to compare two builds' pixels.
	 *                Opt-in: a canvas that can be read back is configured with
	 *                another usage. Same window size and display for runs you
	 *                compare. Frames in the middle of a transition are not
	 *                captured: only what a chart comes to rest at.
	 */
	import { count, avg } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		LineMark,
		AreaMarkY,
		RectYMark,
		BarMarkY,
		Legend
	} from '$lib/components';
	import { AreaMarkX, RectXMark } from '$lib/components/marks';
	import { Toggle, IntervalX } from '$lib/interactors';
	import { Grid } from '$lib/components/guides';
	import { bin } from '$lib/sql/bin';
	import { topN } from '$lib/transforms';
	import { attachQueryLog } from '$lib/query-engine/debug/query-log';

	const { queryEngine, gpuCoordinator } = initFjader();
	const CAPTURE = page.url.searchParams.get('capture') === '1';
	// Before any chart mounts: a canvas reads it when it configures its context.
	if (CAPTURE) gpuCoordinator.readbackEnabled = true;
	// Every transition that starts (lib/animation/transition-log.ts): each
	// renderer's rebin decision (hold, forward and why, swap) and each morph
	// that snaps, with the time, for a flicker seen by eye. In "Save log".
	const transitions = [];
	const offTransitions = gpuCoordinator.observeTransitions((rec) => {
		transitions.push({
			t: rec.time,
			part: rec.part,
			label: rec.label,
			snap: rec.snap,
			detail: rec.detail,
			charts: [...rec.charts]
		});
	});
	onDestroy(offTransitions);
	/** Each case's title and its chart ids (a facet grid has several), to read the transitions by. */
	const caseCharts = () =>
		[...document.querySelectorAll('.case')].map((el) => ({
			title: el.querySelector('h3')?.textContent ?? '',
			charts: [...el.querySelectorAll('canvas')].map((c) => c.dataset.chartId).filter(Boolean)
		}));
	// Every statement the engine sends, with the rows it returned: "Save log".
	const log = attachQueryLog(queryEngine);
	onDestroy(() => log.detach());
	let isLoaded = $state(false);
	let loadError = $state(null);

	// Case 5: bins × (series + 1) across the padding row limit (10 000 rows).
	// 60 bins × 6 is padded (a grid); 3 000 × 6 is not (runs).
	let fine = $state(false);
	const coarseBins = bin('delay', { steps: 60 });
	const fineBins = bin('delay', { steps: 3000 });

	// Case 9: remounts the line inside whatever view the chart has.
	let remounts = $state(0);

	// --- Scripted session (docs/measuring.md) ---------------------------------
	// Zooms deep into case 1 (a line per carrier) and case 4 (faceted stacked
	// areas, the largest cross), then pans each about three views, so a
	// windowed path moves its window several times. The log names each phase
	// (`windows`), for `qlog.py --window zoom-1` and the like.
	let running = $state(false);
	/** The log the last session saved, for the status line. */
	let done = $state(null);
	/** When the page first took pointer or wheel input: the end of its load. */
	let firstInput = null;
	function noteInput() {
		firstInput ??= performance.now();
	}
	let windows = {};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
	const panel = (id) => document.querySelector(`[data-case="${id}"]`);
	const foreground = (id) => panel(id).querySelector('svg.svg-foreground');
	const plotRect = (id) =>
		panel(id).querySelector('rect.interaction-target').getBoundingClientRect();
	const moveType =
		typeof window !== 'undefined' && 'onpointerrawupdate' in window
			? 'pointerrawupdate'
			: 'pointermove';

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

	async function phase(name, run) {
		performance.mark(`fjader:phase:${name}`);
		const start = performance.now();
		await run();
		// Let the last queries land inside the phase.
		await sleep(800);
		windows[name] = { start, end: performance.now() };
	}

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

	/**
	 * Where the data is, as a share of the x axis: the median delay between the
	 * field's min and max. `delay` has a long right tail, so the axis's middle is
	 * almost empty. The axis is niced a little past the data; deep in, that
	 * lands a few minutes off the median, still among the most flights.
	 */
	async function dataCentre() {
		const [row] = (
			await queryEngine.query(
				'SELECT min(delay) AS lo, max(delay) AS hi, median(delay) AS mid FROM pg_flights'
			)
		).toArray();
		const lo = Number(row.lo);
		const hi = Number(row.hi);
		return (Number(row.mid) - lo) / (hi - lo);
	}

	async function zoomAndPan(id, centre, quick) {
		panel(id).scrollIntoView({ block: 'center' });
		await sleep(500);
		const r = plotRect(id);
		const y = r.bottom + 10;
		const at = (f) => r.left + r.width * f;
		const svg = foreground(id);
		pointer(svg.closest('.chart-cell') ?? svg, 'pointerenter', at(centre), y);
		pointer(svg, 'pointerenter', at(centre), y);
		// The wheel handler zooms only after the pointer has dwelt.
		await sleep(400);
		await phase(`zoom-${id}`, async () => {
			for (let i = 0; i < 20; i++) {
				svg.dispatchEvent(
					new WheelEvent('wheel', {
						bubbles: true,
						cancelable: true,
						clientX: at(centre),
						clientY: y,
						deltaY: -100
					})
				);
				await sleep(60);
			}
		});
		// Quick: the long drags only.
		if (!quick) {
			await phase(`pan-${id}`, async () => {
				// Three drags one way and three back, 0.7 of a view each: about two
				// views each way, past the window's margin, so it moves; and back over
				// the data the zoom landed in.
				for (let k = 0; k < 6; k++) {
					const [from, to] = k < 3 ? [0.85, 0.15] : [0.15, 0.85];
					await drag(id, (t) => [at(from + (to - from) * t), y], 1500);
					await sleep(300);
				}
			});
		}
		await phase(`pan-long-${id}`, async () => {
			// One long gesture: pressed in the chart's own axis margin (where a pan
			// starts), then held down out to the window's right edge, across to its
			// left edge and back, past the chart (the pointer is captured). About
			// five views, so the window moves several times within a single pan.
			const stops = [at(centre), window.innerWidth - 20, 20, at(centre)];
			const legs = stops.length - 1;
			await drag(
				id,
				(t) => {
					const k = Math.min(legs - 1, Math.floor(t * legs));
					const u = t * legs - k;
					return [stops[k] + (stops[k + 1] - stops[k]) * u, y];
				},
				12000
			);
		});
		pointer(svg, 'pointerleave', r.right + 1, r.top - 1);
	}

	/**
	 * The full session (cases 1 and 4: zoom, short drags, long drags; about a
	 * minute) or the quick one (case 1: zoom and the long drags; about 15 s).
	 * Saves its log when it ends: no button to wait for.
	 */
	/** Run `session` with pointer capture made safe for its synthetic pointer. */
	async function withSyntheticPointer(session) {
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
		try {
			await session();
		} finally {
			Element.prototype.setPointerCapture = capture;
			Element.prototype.releasePointerCapture = release;
		}
	}

	async function runSession(quick = false) {
		running = true;
		done = null;
		try {
			await withSyntheticPointer(async () => {
				// The page's load: until the first input, by hand or this session's, so a
				// zoom tried by hand before the session is not counted as load.
				windows = { load: { start: 0, end: firstInput ?? performance.now() } };
				const centre = await dataCentre();
				await zoomAndPan(1, centre, quick);
				if (!quick) await zoomAndPan(4, centre, quick);
				const name = `qlog-pathgrid${quick ? '-quick' : ''}.json`;
				log.download(name, { windows, quick, transitions, cases: caseCharts() });
				done = name;
			});
		} finally {
			running = false;
		}
	}

	// --- Captures (?capture=1) -------------------------------------------------
	// What every case comes to rest at, in a fixed sequence of states, as
	// pixels: a net under changes that should not change what is drawn.
	/** The state being captured, for the status line; '' when not running. */
	let capturing = $state('');
	const caseEls = () => [...document.querySelectorAll('.case')];
	const titled = (prefix) =>
		caseEls().find((el) => el.querySelector('h3')?.textContent.startsWith(prefix));
	const fgOf = (el) => el.querySelector('svg.svg-foreground');
	const rectOf = (el) => el.querySelector('rect.interaction-target').getBoundingClientRect();

	function hashPixels(pixels) {
		const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >> 2);
		let hash = words.length;
		for (let i = 0; i < words.length; i++) hash = (Math.imul(hash, 31) + words[i]) | 0;
		return hash >>> 0;
	}

	/** Gzipped, as base64: the pixels exactly, where a PNG through a 2D canvas would premultiply. */
	async function packed(bytes) {
		const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
		const zipped = new Uint8Array(await new Response(stream).arrayBuffer());
		let text = '';
		for (let i = 0; i < zipped.length; i += 0x8000) {
			text += String.fromCharCode.apply(null, zipped.subarray(i, i + 0x8000));
		}
		return btoa(text);
	}

	/**
	 * One case's canvases, once two readbacks in a row are the same pixels: a
	 * case scrolled into view may still be querying or travelling. `settled`
	 * false means ten tries never agreed.
	 */
	async function captureCase(el) {
		// A chart off screen neither queries nor draws.
		el.scrollIntoView({ block: 'center' });
		await sleep(700);
		let last = null;
		let settled = false;
		for (let attempt = 0; attempt < 10 && !settled; attempt++) {
			const map = await gpuCoordinator.captureCharts();
			const shots = [...el.querySelectorAll('canvas')].map((c) => map.get(c) ?? null);
			const hashes = shots.map((shot) => (shot ? hashPixels(shot.pixels) : null));
			settled =
				last !== null &&
				hashes.length === last.hashes.length &&
				hashes.every((h, i) => h !== null && h === last.hashes[i]);
			last = { shots, hashes };
			if (!settled) await sleep(400);
		}
		return last.shots.map((shot, index) => ({ shot, index, hash: last.hashes[index], settled }));
	}

	async function captureState(state, out) {
		capturing = state;
		// Queries for the new state, and the travel to it.
		await sleep(1500);
		for (const el of caseEls()) {
			const title = el.querySelector('h3')?.textContent ?? '';
			for (const { shot, index, hash, settled } of await captureCase(el)) {
				out.push({
					state,
					case: title,
					index,
					settled,
					hash,
					drew: shot?.drew ?? false,
					width: shot?.width ?? 0,
					height: shot?.height ?? 0,
					pixels: shot ? await packed(shot.pixels) : null
				});
			}
		}
		window.scrollTo(0, 0);
		await sleep(300);
	}

	async function captureSession() {
		running = true;
		const out = [];
		// The real pointer out of it: a case scrolled under a resting mouse is
		// hovered, and draws its hover. Dispatched events are not hit-tested.
		const pointerEvents = document.body.style.pointerEvents;
		document.body.style.pointerEvents = 'none';
		try {
			await withSyntheticPointer(async () => {
				const brushEl = titled('Brush');
				const toggleEl = titled('Toggle');
				const at = (el, fx) => {
					const r = rectOf(el);
					return r.left + r.width * fx;
				};
				const mid = (el) => {
					const r = rectOf(el);
					return r.top + r.height / 2;
				};
				// A cell takes a gesture only once the pointer has entered it: without
				// this a drag in the plot panned the axis in one run and brushed in
				// another, by where the real mouse had been.
				const enter = async (el, x, y) => {
					const svg = fgOf(el);
					pointer(svg.closest('.chart-cell') ?? svg, 'pointerenter', x, y);
					pointer(svg, 'pointerenter', x, y);
					await sleep(200);
				};
				const leave = (el) => {
					const r = rectOf(el);
					const svg = fgOf(el);
					pointer(svg, 'pointerleave', r.right + 1, r.top - 1);
					pointer(svg.closest('.chart-cell') ?? svg, 'pointerleave', r.right + 1, r.top - 1);
				};
				const brush = async (f0, f1) => {
					const svg = fgOf(brushEl);
					const y = mid(brushEl);
					await enter(brushEl, at(brushEl, f0), y);
					pointer(svg, 'pointerdown', at(brushEl, f0), y, 1);
					for (let k = 1; k <= 12; k++) {
						await frame();
						pointer(svg, moveType, at(brushEl, f0 + ((f1 - f0) * k) / 12), y, 1);
					}
					pointer(svg, 'pointerup', at(brushEl, f1), y, 0);
					leave(brushEl);
				};
				const click = async (el, x, y) => {
					await enter(el, x, y);
					fgOf(el).dispatchEvent(
						new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })
					);
					leave(el);
				};
				const zoomIn = async (el, centre) => {
					el.scrollIntoView({ block: 'center' });
					await sleep(500);
					const r = rectOf(el);
					const x = r.left + r.width * centre;
					const y = r.bottom + 10;
					const svg = fgOf(el);
					pointer(svg.closest('.chart-cell') ?? svg, 'pointerenter', x, y);
					pointer(svg, 'pointerenter', x, y);
					// The wheel handler zooms only after the pointer has dwelt.
					await sleep(400);
					// Each step left to settle before the next: steps that overlap end
					// at a view that depends on their timing.
					for (let i = 0; i < 8; i++) {
						svg.dispatchEvent(
							new WheelEvent('wheel', {
								bubbles: true,
								cancelable: true,
								clientX: x,
								clientY: y,
								deltaY: -100
							})
						);
						await sleep(500);
					}
					leave(el);
				};

				window.scrollTo(0, 0);
				await captureState('load', out);

				// Under 310 miles: short flights only.
				await brush(0.02, 0.1);
				await captureState('brush-low', out);

				// Past 1 500 miles: the flights with no carrier come in.
				await brush(0.55, 0.95);
				await captureState('brush-high', out);

				// A press outside the range clears it.
				await enter(brushEl, at(brushEl, 0.3), mid(brushEl));
				pointer(fgOf(brushEl), 'pointerdown', at(brushEl, 0.3), mid(brushEl), 1);
				pointer(fgOf(brushEl), 'pointerup', at(brushEl, 0.3), mid(brushEl), 0);
				leave(brushEl);
				await captureState('unbrushed', out);

				// The first of the three bands, by its axis label.
				const tr = rectOf(toggleEl);
				await click(toggleEl, tr.left + tr.width / 6, tr.bottom + 10);
				await captureState('toggle', out);

				// Empty plot space clears the toggle.
				await click(toggleEl, tr.right - 4, tr.top + 4);
				await captureState('untoggled', out);

				fine = true;
				await captureState('fine-bins', out);
				fine = false;
				await sleep(1500);

				const centre = await dataCentre();
				for (const prefix of ['1.', '11.', '12.']) await zoomIn(titled(prefix), centre);
				await captureState('zoomed', out);
			});
			const blob = new Blob(
				[
					JSON.stringify({
						page: 'path-grid',
						format: navigator.gpu.getPreferredCanvasFormat(),
						viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
						userAgent: navigator.userAgent,
						captures: out
					})
				],
				{ type: 'application/json' }
			);
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = 'captures-pathgrid.json';
			a.click();
			URL.revokeObjectURL(a.href);
			done = a.download;
		} finally {
			document.body.style.pointerEvents = pointerEvents;
			capturing = '';
			running = false;
		}
	}

	onMount(async () => {
		try {
			const url = `${window.location.origin}/data/flights-200k.parquet`;
			// Carriers made to differ, so a cell or a line showing another's data is
			// seen at once: each keeps a different share of its flights (AA all, B6
			// a fifth) and its delays are shifted 15 minutes more than the last
			// one's. The bands are thirds of the distances.
			// - 'B6' has no long flights: its long rows exist only as padding.
			// - 'UA' has no medium or long flights delayed 60 to 110 minutes: a hole
			//   in the middle of its range that only its short flights fill, so the
			//   toggle and the brush open and close it.
			// - A third of the flights over 1 500 miles have no carrier: the absent
			//   series, which the brush brings in and takes out.
			// `reach` is `band` again under another name, for the toggle: a selection
			// on a field a mark colours by DIMS that mark, and case 4 colours by
			// band. On a field no mark draws, it filters every case.
			await queryEngine.exec(`
				CREATE TABLE pg_flights AS
				SELECT
					delay + 15 * k AS delay, distance, band, band AS reach,
					CASE WHEN distance > 1500 AND n % 3 = 0 THEN NULL ELSE carrier END AS carrier
				FROM (
					SELECT
						delay, distance, k,
						['AA', 'DL', 'UA', 'WN', 'B6'][1 + k] AS carrier,
						CASE WHEN distance < 310 THEN 'short' WHEN distance < 490 THEN 'medium' ELSE 'long' END AS band,
						n
					FROM (
						SELECT delay, distance, (row_number() OVER ())::INT AS n, (row_number() OVER () % 5)::INT AS k
						FROM read_parquet('${url}')
					)
				)
				WHERE (n // 5) % 5 >= k AND NOT (carrier = 'B6' AND band = 'long')
					AND NOT (carrier = 'UA' AND distance >= 310 AND delay + 15 * k BETWEEN 60 AND 110)
			`);
			isLoaded = true;
		} catch (error) {
			if (error?.name === 'AbortError') return;
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<svelte:window onpointerdowncapture={noteInput} onwheelcapture={noteInput} />

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading…</p>
{:else}
	<div class="container">
		<h1>Lines and areas over bins, with a series</h1>
		<p class="lede">
			Every chart bins <code>delay</code> and splits by a series. Hover to check the tooltips follow
			the lines. Pan and zoom each: the paths should stay whole. Then brush and toggle in the two charts
			at the top: cases 1 to 4 and 6 TRAVEL to the new values. Nothing jumps, crosses another series
			on the way, or opens a gap between a stack's bands, and a slow drag of the brush feels continuous.
		</p>

		<p>
			<button onclick={() => runSession(true)} disabled={running}>Quick session (15 s)</button>
			<button onclick={() => runSession()} disabled={running}>Full session (1 min)</button>
			<button
				onclick={() =>
					log.download('qlog-pathgrid.json', { windows, transitions, cases: caseCharts() })}
				disabled={running}
			>
				Save log
			</button>
			{#if CAPTURE}
				<button onclick={captureSession} disabled={running}>Save captures (3 min)</button>
			{/if}
			{#if running}
				<strong class="session-status"
					>Running{capturing ? ` (${capturing})` : ''}: don't move the mouse.</strong
				>
			{:else if done}
				<strong class="session-status"
					>Done: saved {done} to Downloads. Reload for the next run.</strong
				>
			{/if}
			<br />
			Quick: case 1 zoomed deep at the median delay, then one long drag each way. Full: cases 1 and 4,
			with short drags before the long ones. Each saves its log when it ends.
		</p>

		<div class="grid sticky">
			<div class="case">
				<h3>Brush: distance</h3>
				<p class="desc">
					Drag a range. Under 310 miles: short flights only. Past 1 500: some have no carrier.
				</p>
				<div class="panel short">
					<ChartContainer xLabel="distance" yLabel="flights">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<RectYMark
							table="pg_flights"
							x={bin('distance', { steps: 60 })}
							y={count()}
							inset={0.5}
							fill="steelblue"
							selection="pg"
						/>
						<IntervalX selection="pg" />
					</ChartContainer>
				</div>
			</div>
			<div class="case">
				<h3>Toggle: reach (short, medium, long)</h3>
				<p class="desc">Click a bar to keep those flights only; click the plot to clear.</p>
				<div class="panel short">
					<ChartContainer xLabel="reach" yLabel="flights">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<BarMarkY table="pg_flights" x="reach" y={count()} selection="pg" />
						<Toggle selection="pg" field="reach" />
					</ChartContainer>
				</div>
			</div>
		</div>

		<div class="grid">
			<div class="case">
				<h3>1. A line per carrier</h3>
				<p class="desc">
					Five lines of counts, one per carrier: AA the tallest, B6 the lowest, each peak a little
					right of the last. A sixth, low line is the flights with no carrier, all over 1 500 miles.
					No line jumps between carriers. Keep 'long' only (the toggle): UA has no such flights
					delayed 60 to 110 minutes, and a count of none is 0, so its line travels down to the
					baseline across that stretch, unbroken. Brush a range under 1 500 miles: the sixth line
					goes at once (it is left out, not drawn at zero); widen the brush past 1 500 and it is
					back at once, with nothing to travel from.
				</p>
				<div class="panel" data-case="1">
					<ChartContainer xLabel="delay" yLabel="count">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<Grid />
						<LineMark
							table="pg_flights"
							x={bin('delay', { steps: 50 })}
							y={count()}
							stroke="carrier"
							selection="pg"
						/>
						<Legend position="right" />
					</ChartContainer>
				</div>
			</div>

			<div class="case">
				<h3>2. The same, curved</h3>
				<p class="desc">
					<code>curve="monotone"</code>: smooth lines through the same points, with no kink or
					overshoot at the first and last bin, where a curve has no neighbour to lean on.
				</p>
				<div class="panel">
					<ChartContainer xLabel="delay" yLabel="count">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<Grid />
						<LineMark
							table="pg_flights"
							x={bin('delay', { steps: 50 })}
							y={count()}
							stroke="carrier"
							curve="monotone"
							selection="pg"
						/>
					</ChartContainer>
				</div>
			</div>

			<div class="case">
				<h3>3. A stacked area with an outline</h3>
				<p class="desc">
					Five bands stacked on each other, filled, each with a dark outline along its top that
					follows the fill exactly. Curved. No gaps between bands.
				</p>
				<div class="panel">
					<ChartContainer xLabel="delay" yLabel="count">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<Grid />
						<AreaMarkY
							table="pg_flights"
							x={bin('delay', { steps: 50 })}
							y={count()}
							fill="carrier"
							fillOpacity={0.5}
							stroke="#333"
							strokeWidth={1.5}
							curve="monotone"
							selection="pg"
						/>
					</ChartContainer>
				</div>
			</div>

			<div class="case wide">
				<h3>4. Faceted by carrier, stacked by distance band</h3>
				<p class="desc">
					One cell per carrier, each a stack of three bands with outlines. The cells differ: from AA
					to B6 each is lower than the last (AA about five times B6) and its peak sits further
					right. B6 has no long flights: its cell shows two bands. Nothing leaks in from the next
					cell at either edge.
				</p>
				<div class="panel" data-case="4">
					<ChartContainer xLabel="delay" yLabel="count" fx="carrier">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<AreaMarkY
							table="pg_flights"
							x={bin('delay', { steps: 30 })}
							y={count()}
							fill="band"
							fillOpacity={0.5}
							stroke="#333"
							strokeWidth={1}
							selection="pg"
						/>
					</ChartContainer>
				</div>
			</div>

			<div class="case">
				<h3>5. Across the padding limit</h3>
				<p class="desc">
					60 bins are padded (a grid); 3 000 are past the row limit, so the result is not padded
					(runs) and the line may be decimated. Switch back and forth: five lines each time, never
					an empty chart, a scramble of lines between carriers, or a console error.
				</p>
				<div class="controls">
					<button onclick={() => (fine = !fine)}
						>bins: {fine ? '3 000 (runs)' : '60 (a grid)'}</button
					>
				</div>
				<div class="panel">
					<ChartContainer xLabel="delay" yLabel="count">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<Grid />
						<LineMark
							table="pg_flights"
							x={fine ? fineBins : coarseBins}
							y={count()}
							stroke="carrier"
							selection="pg"
						/>
					</ChartContainer>
				</div>
			</div>

			<div class="case">
				<h3>6. A line of means: a gap where there is no data</h3>
				<p class="desc">
					Mean distance per carrier. Keep 'long' only (the toggle): UA has no such flights delayed
					60 to 110 minutes, so it has no mean there. Its line breaks at once across that stretch,
					with nothing in between, and never dips to zero, while the rest of it and the other four
					lines travel. Clear the toggle: the gap fills at once, at the new values, as the lines
					around it are still arriving. Hovering inside the gap shows the other carriers and nothing
					for UA.
				</p>
				<div class="panel">
					<ChartContainer xLabel="delay" yLabel="mean distance">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<Grid />
						<LineMark
							table="pg_flights"
							x={bin('delay', { steps: 50 })}
							y={avg('distance')}
							stroke="carrier"
							selection="pg"
						/>
					</ChartContainer>
				</div>
			</div>
			<div class="case">
				<h3>7. A line over a histogram: the point is the bin's centre</h3>
				<p class="desc">
					Twelve wide bins, drawn twice on one chart: as bars and as a line with dots. Each dot sits
					in the middle of its bar, at the bar's top. Before, a binned line's points sat on their
					bars' left edges, half a bin left of the data. The line starts and ends half a bin inside
					the plot, where the first and last bars have their middles.
				</p>
				<div class="panel">
					<ChartContainer xLabel="delay" yLabel="count">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<RectYMark
							table="pg_flights"
							x={bin('delay', { steps: 12 })}
							y={count()}
							inset={0.5}
							fill="#c9d6e8"
							selection="pg"
						/>
						<LineMark
							table="pg_flights"
							x={bin('delay', { steps: 12 })}
							y={count()}
							stroke="#1f3b63"
							dotRadius={4}
							lod={false}
							selection="pg"
						/>
					</ChartContainer>
				</div>
			</div>
			<div class="case">
				<h3>8. A horizontal area over horizontal bars</h3>
				<p class="desc">
					The same twelve bins on the y axis: bars growing to the right, and an area with dots over
					them. Each dot sits at the end of its bar, in the middle of the bar's height. The area has
					interval channels on both axes here (its value's and its bins'), so this is also the check
					that it bins along y.
				</p>
				<div class="panel tall">
					<ChartContainer xLabel="count" yLabel="delay">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<RectXMark
							table="pg_flights"
							y={bin('delay', { steps: 12 })}
							x={count()}
							inset={0.5}
							fill="#c9d6e8"
							selection="pg"
						/>
						<AreaMarkX
							table="pg_flights"
							y={bin('delay', { steps: 12 })}
							x={count()}
							fill="#1f3b63"
							fillOpacity={0.25}
							stroke="#1f3b63"
							strokeWidth={1.5}
							dotRadius={4}
							selection="pg"
						/>
					</ChartContainer>
				</div>
			</div>
			<div class="case">
				<h3>9. A line mounted into a zoomed chart</h3>
				<p class="desc">
					Case 1's lines. Note the top of the y axis, zoom deep into the x axis (the lines refine
					and flatten, the axis stays), then press Remount: the lines are made again inside the
					zoomed view. The y axis must read what it read before, the whole extent's: a line takes
					its value axis from a first result over the whole extent, never from a window.
				</p>
				<button onclick={() => remounts++}>Remount ({remounts})</button>
				<div class="panel">
					<ChartContainer xLabel="delay" yLabel="count">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<Grid />
						{#key remounts}
							<LineMark
								table="pg_flights"
								x={bin('delay', { steps: 50 })}
								y={count()}
								stroke="carrier"
								selection="pg"
							/>
						{/key}
					</ChartContainer>
				</div>
			</div>
			<div class="case">
				<h3>11. Rebins ride: a line of means per carrier</h3>
				<p class="desc">
					Mean distance per carrier over delay, with automatic bins. Zoom in and out, and
					shift+scroll over a line: on each rebin the lines keep their shape and glide to the new
					bins' values. Zooming in, the new points start on the old lines (no flat steps); zooming
					out, at the average of what they cover. A mean does not change unit with the bin width, so
					the y axis can stay as it is. Points past the old rows appear at once, as do gaps.
				</p>
				<div class="panel">
					<ChartContainer xLabel="delay" yLabel="mean distance">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<Grid />
						<LineMark
							table="pg_flights"
							x={bin('delay')}
							y={avg('distance')}
							stroke="carrier"
							selection="pg"
						/>
						<Legend position="right" />
					</ChartContainer>
				</div>
			</div>
			<div class="case">
				<h3>12. Rebins ride: a stacked area of means, with its outline</h3>
				<p class="desc">
					Mean distance per carrier, stacked, filled, with an outline along each band's top;
					automatic bins. Zoom and shift+scroll: the fill and its outline ride every rebin together,
					and no gap opens between bands at any frame.
				</p>
				<div class="panel">
					<ChartContainer xLabel="delay" yLabel="mean distance (stacked)">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<Grid />
						<AreaMarkY
							table="pg_flights"
							x={bin('delay')}
							y={avg('distance')}
							fill="carrier"
							fillOpacity={0.5}
							stroke="#333"
							strokeWidth={1.5}
							curve="monotone"
							selection="pg"
						/>
					</ChartContainer>
				</div>
			</div>
			<div class="case">
				<h3>10. The top three carriers (topN)</h3>
				<p class="desc">
					Case 1's lines, kept to the three carriers with the most flights. A topN re-reads the
					series from every result, so this is the check that it does not re-read the y axis from a
					window: note the top of the y axis, zoom deep into the x axis, then brush and toggle above
					and pan. The y axis must not shrink to the rows in view; it stays the whole extent's.
				</p>
				<div class="panel">
					<ChartContainer xLabel="delay" yLabel="count">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<Grid />
						<LineMark
							table="pg_flights"
							x={bin('delay', { steps: 50 })}
							y={count()}
							stroke="carrier"
							transforms={[topN(3)]}
							selection="pg"
						/>
						<Legend position="right" />
					</ChartContainer>
				</div>
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
	.lede,
	.desc {
		color: #555;
		max-width: 80ch;
	}
	.desc {
		font-size: 13px;
		margin: 4px 0 8px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(360px, 1fr));
		gap: 24px 16px;
	}
	.session-status {
		margin-left: 8px;
		padding: 2px 8px;
		background: #fff3c4;
	}
	.case.wide {
		grid-column: 1 / -1;
	}
	.panel {
		height: 300px;
	}
	.panel.tall {
		height: 380px;
	}
	.panel.short {
		height: 120px;
	}
	/* The controls stay in view, so a case further down can be watched while
	   it is brushed or toggled. Opaque: the cases scroll under it. */
	.sticky {
		position: sticky;
		top: 0;
		z-index: 10;
		background: Canvas;
		padding: 8px 0;
		border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
	}
	.sticky h3 {
		margin: 0;
		font-size: 13px;
	}
	.sticky .desc {
		margin: 2px 0 4px;
		font-size: 12px;
	}
	.controls {
		margin-bottom: 6px;
	}
	.status.error {
		color: #b00020;
	}
</style>
