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
	 */
	import { count, avg } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onDestroy, onMount } from 'svelte';
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

	const { queryEngine } = initFjader();
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
			// One long gesture each way: the pointer stays down from one edge of the
			// window to the other, past the chart (it is captured), about three views,
			// so the window moves several times within a single pan.
			const edges = [window.innerWidth - 20, 20];
			for (const [from, to] of [edges, [edges[1], edges[0]]]) {
				await drag(id, (t) => [from + (to - from) * t, y], 6000);
				await sleep(300);
			}
		});
		pointer(svg, 'pointerleave', r.right + 1, r.top - 1);
	}

	/**
	 * The full session (cases 1 and 4: zoom, short drags, long drags; about a
	 * minute) or the quick one (case 1: zoom and the long drags; about 15 s).
	 * Saves its log when it ends: no button to wait for.
	 */
	async function runSession(quick = false) {
		running = true;
		done = null;
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
			// The page's load: until the first input, by hand or this session's, so a
			// zoom tried by hand before the session is not counted as load.
			windows = { load: { start: 0, end: firstInput ?? performance.now() } };
			const centre = await dataCentre();
			await zoomAndPan(1, centre, quick);
			if (!quick) await zoomAndPan(4, centre, quick);
			const name = `qlog-pathgrid${quick ? '-quick' : ''}.json`;
			log.download(name, { windows, quick });
			done = name;
		} finally {
			Element.prototype.setPointerCapture = capture;
			Element.prototype.releasePointerCapture = release;
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
			<button onclick={() => log.download('qlog-pathgrid.json', { windows })} disabled={running}>
				Save log
			</button>
			{#if running}
				<strong class="session-status">Running: don't move the mouse.</strong>
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
