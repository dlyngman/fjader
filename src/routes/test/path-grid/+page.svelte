<script>
	/**
	 * Lines and areas over a binned axis with a series: a padded result, whose
	 * rows come back bin by bin with the series interleaved (a grid), not series
	 * by series (runs). Each case says what should be seen.
	 *
	 * Before the path renderers could address a grid, cases 1 to 4 drew nothing
	 * (areas: no fill; lines: nothing at all), with no error.
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
		Legend
	} from '$lib/components';
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
			// seen at once: each carrier keeps a different share of its flights
			// (AA all, B6 a fifth) and its delays are shifted by 15 minutes more than
			// the last one's. The bands are thirds of the distances. 'B6' also has no long flights, so its long rows exist
			// only as padding.
			// 'UA' has no flights delayed 60 to 110 minutes: a hole in the middle of
			// its range, where a count is 0 and a mean is a gap.
			await queryEngine.exec(`
				CREATE TABLE pg_flights AS
				SELECT delay + 15 * k AS delay, distance, carrier, band FROM (
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
					AND NOT (carrier = 'UA' AND delay + 15 * k BETWEEN 60 AND 110)
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
			the lines. Pan and zoom each: the paths should stay whole.
		</p>

		<div class="grid">
			<div class="case">
				<h3>1. A line per carrier</h3>
				<p class="desc">
					Five lines of counts, one per carrier, each joined along the bins: AA the tallest, B6 the
					lowest, each peak a little right of the last. No line jumps between carriers, and no extra
					line runs along the baseline: the padding's own series, for a carrier the data does not
					have, is left out when it is empty. UA has no flights delayed 60 to 110 minutes: a count
					of none is 0, so its line drops to the baseline across that stretch and comes back,
					unbroken.
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
						/>
					</ChartContainer>
				</div>
			</div>

			<div class="case">
				<h3>6. A line of means: a gap where there is no data</h3>
				<p class="desc">
					Mean distance per carrier. UA has no flights delayed 60 to 110 minutes, so it has no mean
					there: its line stops before 60 and starts again after 110, with nothing in between, and
					never dips to zero. The other four lines run through. At the ends, each line simply starts
					and stops where its carrier's flights do. Hovering inside UA's gap shows the other
					carriers and nothing for UA.
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
	.controls {
		margin-bottom: 6px;
	}
	.status.error {
		color: #b00020;
	}
</style>
