<script>
	// Verification harness for §29.10a — a temporal categorical value is
	// rendered as a raw epoch number.
	//
	// WHAT THIS PAGE IS, AND WHAT IT REPLACED. The first version of this page
	// demonstrated a different bug that does not exist: that a dim over a DATE
	// column holds JS `Date` objects, and that FieldIdentity's Map therefore
	// misses on reference identity. The measurement behind that was taken
	// against the `duckdb` npm package, which the integration tests use and the
	// APP DOES NOT. Recorded as §29.10b, because it is the more general trap:
	//
	//   the app     duckdb-wasm -> queryIPC -> flechette tableFromIPC
	//   the tests   the `duckdb` npm package, db.all()
	//
	// flechette's `useDate` defaults to FALSE — batch-type.js:26-37 reads
	// `useDate && DateBatch`, so an unset option falls through to DateDayBatch
	// and TimestampMicrosecondBatch, both numeric — and QueryEngine.#queryRaw
	// passes no options. So in the app a DATE is epoch MILLISECONDS as a
	// number (DateDayBatch: `86400000 * days`), and a TIMESTAMP likewise.
	//
	// That is good news for identity: a number is a primitive, so the Map
	// round-trips and ordering works. The probe panel below proves it rather
	// than asserting it, and it is the check that should have been run first.
	//
	// THE BUG THAT IS REAL. Every label path coerces with a bare `String(v)`:
	//
	//   ChartContainer.svelte:411   facetLabel={String(cat)}       <- these cells
	//   BandScaleState.tickFormat   String(d[index] ?? '')         <- a band axis
	//
	// Both are correct for VARCHAR, INTEGER and BIGINT — a year, a rating, a
	// zip code are all rendered exactly right — and both are useless for DATE
	// and TIMESTAMP. This is not a facet quirk; it is the same line of
	// reasoning in two components, and faceting is simply where a temporal
	// categorical is reachable at all (scale inference sends a date on an AXIS
	// to a time scale, while ChartContainer.svelte:111 builds the facet scale
	// as 'band' with no inference).
	//
	// WHY `String` CANNOT BE FIXED IN PLACE. An epoch millisecond and a zip
	// code are both numbers. Nothing at the point of coercion can tell them
	// apart, which is why chart 4 works and charts 2 and 3 cannot: the fix
	// needs the dim's SQL TYPE carried on FieldIdentity, and only
	// CategoricalIdentity is positioned to capture it. tickFormat's own comment
	// already says formatting "stays in the scale/axis layer" — correct, and
	// the scale layer has no way to know.
	//
	// WHAT TO LOOK FOR
	//
	//   Chart 1  VARCHAR, the control  -> cells read A, B, C.
	//   Chart 2  DATE                  -> cells SHOULD read 2024-01-01 ... and
	//   Chart 3  TIMESTAMP                TODAY read 1704067200000 and friends.
	//   Chart 4  the workaround        -> cells read 2024-01, 2024-02, 2024-03.
	//
	// Chart 4 is what a user has to do today: pre-compute a VARCHAR column.
	// Note it is a WORKAROUND and not the natural spelling — `fx` is typed
	// `string | null` (ChartContainer.svelte:18), so a facet cannot be given a
	// SQL expression and `fx={strftime(...)}` is not available. The column has
	// to exist in the table.
	//
	// A SECOND TRAP, shown in the panel rather than as a chart. `fxDomain` is
	// compared against dim values, so ordering a temporal facet means writing
	// EPOCH NUMBERS in that prop — a JS `Date` there misses silently. The panel
	// prints the exact numbers this page's data requires, which is the only way
	// anyone would find them.
	//
	// EACH CHART FACETS ON ITS OWN COLUMN. ScaleRegistry keys scales by name
	// plus type plus config and a facet scale is named `__facet__<fx>`, so two
	// containers faceting on one field share a BandScaleState (§25.3 bug 1).

	import { onMount } from 'svelte';
	import { count } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		WebGPUCanvas,
		BarMarkY
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';

	const { queryEngine } = initDivePlot();
	let isLoaded = $state(false);
	let error = $state(null);
	let probes = $state([]);

	/**
	 * Report the JS type the dim actually holds, and what String() makes of it.
	 * This is the whole question both drafts of §29.10 turned on.
	 */
	function probe(field, expectation) {
		const identity = queryEngine.identityFor(field);
		const first = identity.values[0];
		const kind =
			first === null || first === undefined
				? 'empty'
				: typeof first === 'object'
					? `object(${first.constructor?.name ?? '?'})`
					: typeof first;

		return {
			field,
			kind,
			count: identity.values.length,
			// What the facet cell heading and the axis tick both produce.
			rendered: identity.values.map((v) => String(v)).join(', '),
			// A Map keyed by a primitive round-trips; one keyed by an object
			// does not. Re-look-up every value through the public reverse map.
			roundTrips: identity.values.every((v) => identity.ids.get(v) !== undefined),
			expectation
		};
	}

	onMount(async () => {
		try {
			// Four columns, four dims, four facet scales. `month_text` is
			// pre-computed in SQL because `fx` takes a column name, not an
			// expression — that limitation is the point of chart 4.
			await queryEngine.exec([
				`CREATE TABLE fx_varchar AS SELECT * FROM (VALUES
					('A', 3), ('B', 7), ('C', 5), ('A', 2), ('B', 1), ('C', 9)
				) t(cat_varchar, amount)`,
				`CREATE TABLE fx_date AS SELECT * FROM (VALUES
					(DATE '2024-01-01', 3), (DATE '2024-02-01', 7), (DATE '2024-03-01', 5),
					(DATE '2024-01-01', 2), (DATE '2024-02-01', 1), (DATE '2024-03-01', 9)
				) t(cat_date, amount)`,
				`CREATE TABLE fx_ts AS SELECT * FROM (VALUES
					(TIMESTAMP '2024-01-01 12:00:00', 3), (TIMESTAMP '2024-02-01 12:00:00', 7),
					(TIMESTAMP '2024-03-01 12:00:00', 5), (TIMESTAMP '2024-01-01 12:00:00', 2),
					(TIMESTAMP '2024-02-01 12:00:00', 1), (TIMESTAMP '2024-03-01 12:00:00', 9)
				) t(cat_ts, amount)`,
				`CREATE TABLE fx_month AS
					SELECT strftime(cat_date, '%Y-%m') AS month_text, amount FROM fx_date`
			]);

			isLoaded = true;

			// After the marks have set up, so the dims exist.
			setTimeout(() => {
				try {
					probes = [
						probe('cat_varchar', 'A, B, C'),
						probe('cat_date', '2024-01-01, 2024-02-01, 2024-03-01'),
						probe('cat_ts', '2024-01-01 12:00, 2024-02-01 12:00, 2024-03-01 12:00'),
						probe('month_text', '2024-01, 2024-02, 2024-03')
					];
				} catch (e) {
					error = String(e);
				}
			}, 1500);
		} catch (e) {
			error = String(e);
		}
	});
</script>

<div class="page">
	<h1>Temporal facet labels &mdash; §29.10a</h1>
	<p class="lede">
		A DATE reaches the app as epoch <strong>milliseconds, as a number</strong> — flechette's
		<code>useDate</code>
		defaults to false and <code>#queryRaw</code> passes no options. Identity is fine: a number is a
		primitive, so the Map round-trips. What is broken is every label path, because
		<code>String(v)</code> cannot tell an epoch from a zip code.
	</p>

	{#if error}
		<pre class="error">{error}</pre>
	{/if}

	<div class="panel">
		<h2>What the dim holds</h2>
		{#if probes.length === 0}
			<p class="muted">Waiting for the dims to be built&hellip;</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>field</th>
						<th>JS type</th>
						<th>ids round-trip</th>
						<th><code>String(v)</code> &mdash; what a cell heading shows</th>
						<th>should read</th>
					</tr>
				</thead>
				<tbody>
					{#each probes as p (p.field)}
						<tr class:bad={p.rendered !== p.expectation}>
							<td><code>{p.field}</code></td>
							<td><code>{p.kind}</code></td>
							<td>{p.roundTrips ? 'yes' : 'NO'}</td>
							<td><code>{p.rendered}</code></td>
							<td>{p.expectation}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="muted">
				The <code>ids round-trip</code> column is the claim §29.10's first draft got wrong: it said
				these were <code>Date</code> objects and therefore missed. They are numbers, and they do not
				miss. The numbers under <code>String(v)</code> for the two temporal rows are also exactly
				what an <code>fxDomain</code> would have to contain to order those grids &mdash; a JS
				<code>Date</code> there compares against a number and is silently dropped.
			</p>
		{/if}
	</div>

	{#if isLoaded}
		<h2>1. VARCHAR &mdash; the control. Cells read A, B, C.</h2>
		<div class="chart">
			<ChartContainer xLabel="cat" yLabel="count" fx="cat_varchar">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<BarMarkY table="fx_varchar" x="cat_varchar" y={count()} fill="cat_varchar" />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
				{#snippet background()}
					<Frame />
					<AxisLeft />
					<AxisBottom />
				{/snippet}
			</ChartContainer>
		</div>

		<h2>2. DATE &mdash; headings should be dates. Today they are epoch millis.</h2>
		<div class="chart">
			<ChartContainer xLabel="cat" yLabel="count" fx="cat_date">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<BarMarkY table="fx_date" x="cat_date" y={count()} fill="cat_date" />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
				{#snippet background()}
					<Frame />
					<AxisLeft />
					<AxisBottom />
				{/snippet}
			</ChartContainer>
		</div>

		<h2>3. TIMESTAMP &mdash; same bug, same cause.</h2>
		<div class="chart">
			<ChartContainer xLabel="cat" yLabel="count" fx="cat_ts">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<BarMarkY table="fx_ts" x="cat_ts" y={count()} fill="cat_ts" />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
				{#snippet background()}
					<Frame />
					<AxisLeft />
					<AxisBottom />
				{/snippet}
			</ChartContainer>
		</div>

		<h2>4. The workaround &mdash; a pre-computed VARCHAR month. Cells read 2024-01, 02, 03.</h2>
		<p class="note">
			<code>strftime</code> in the table definition, not in <code>fx</code>: the prop is typed
			<code>string | null</code>, so a facet cannot take a SQL expression. This also truncates,
			which is the operation a temporal facet almost always wants &mdash; one cell per distinct
			TIMESTAMP is one cell per row, and nothing currently refuses that (§29.11).
		</p>
		<div class="chart">
			<ChartContainer xLabel="cat" yLabel="count" fx="month_text">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<BarMarkY table="fx_month" x="month_text" y={count()} fill="month_text" />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
				{#snippet background()}
					<Frame />
					<AxisLeft />
					<AxisBottom />
				{/snippet}
			</ChartContainer>
		</div>
	{:else if !error}
		<p class="muted">Loading&hellip;</p>
	{/if}
</div>

<style>
	.page {
		padding: 1.5rem 2rem 4rem;
		font-family: system-ui, sans-serif;
		max-width: 1100px;
	}
	h1 {
		font-size: 1.3rem;
	}
	h2 {
		font-size: 0.95rem;
		font-weight: 600;
		margin: 2rem 0 0.5rem;
	}
	.lede,
	.note {
		max-width: 74ch;
		line-height: 1.5;
		color: #333;
	}
	.note {
		font-size: 0.85rem;
		color: #555;
		margin: 0 0 0.6rem;
	}
	.chart {
		height: 260px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
	}
	.panel {
		margin: 1.5rem 0;
		padding: 1rem;
		border: 1px solid #d0d0d0;
		border-radius: 4px;
		background: #fafafa;
	}
	.panel h2 {
		margin: 0 0 0.75rem;
	}
	table {
		border-collapse: collapse;
		font-size: 0.82rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.3rem 0.9rem 0.3rem 0;
		border-bottom: 1px solid #e8e8e8;
		vertical-align: top;
	}
	tr.bad td {
		color: #b00020;
		font-weight: 600;
	}
	.muted {
		color: #666;
		font-size: 0.85rem;
		max-width: 74ch;
		line-height: 1.5;
	}
	.error {
		color: #b00020;
		white-space: pre-wrap;
	}
	code {
		font-family: ui-monospace, monospace;
		font-size: 0.85em;
	}
</style>
