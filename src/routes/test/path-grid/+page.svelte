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
	import { onMount } from 'svelte';
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
	import { Toggle, IntervalX } from '$lib/interactors';
	import { Grid } from '$lib/components/guides';
	import { bin } from '$lib/sql/bin';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	// Case 5: bins × (series + 1) across the padding row limit (10 000 rows).
	// 60 bins × 6 is padded (a grid); 3 000 × 6 is not (runs).
	let fine = $state(false);
	const coarseBins = bin('delay', { steps: 60 });
	const fineBins = bin('delay', { steps: 3000 });

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
				<div class="panel">
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
	.case.wide {
		grid-column: 1 / -1;
	}
	.panel {
		height: 300px;
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
