<script>
	// Verification harness for §29.10 — a dim whose values are JS OBJECTS.
	//
	// `DimValue` is declared `string | number | bigint`. That is what the driver
	// returns for VARCHAR, INTEGER, BIGINT, HUGEINT, DECIMAL, DOUBLE and TIME.
	// It is NOT what the driver returns for DATE and TIMESTAMP, which arrive as
	// JS `Date` OBJECTS (also INTERVAL as a plain object, BLOB as a Buffer).
	//
	// Why that is a correctness bug and not a typo. `FieldIdentity` holds both
	// directions of the bijection, and the value -> id direction is a `Map`
	// keyed by the value. A Map keyed by an OBJECT matches on reference
	// identity, not on value. Two Dates for the same instant, produced by two
	// different queries, are two different objects — so `ids.get(d)` misses
	// every time the value crossed a query boundary.
	//
	// Verified at the driver, not reasoned about:
	//
	//   VARCHAR/INTEGER/BIGINT/HUGEINT/DECIMAL/DOUBLE/TIME -> primitive, hits
	//   DATE / TIMESTAMP                                   -> Date object, MISSES
	//   INTERVAL / BLOB                                    -> object, MISSES
	//   BOOLEAN                                            -> boolean: hits, but
	//                                                         is also outside
	//                                                         DimValue's three
	//
	// WHY FACETING IS THE PATH. Scale inference sends a date on an AXIS to a
	// `time` scale (scale-inference.ts:55), so a band axis over a date is not
	// reachable that way. Faceting is: ChartContainer.svelte:111 creates the
	// facet scale as `'band'` UNCONDITIONALLY, with no inference at all. So
	// `fx="a_date_column"` is an ordinary, public-API route to a Date-valued
	// dim, and it is the only one.
	//
	// WHY fxDomain IS THE TRIGGER. The plain facet path does not miss, which is
	// why this has gone unnoticed: domain-queries.ts:234 registers the dim's
	// OWN array, so the objects on both sides are the same instances and the
	// lookup hits. The miss needs values that did NOT come from the dim's read.
	// `fxDomain` is exactly that — values written by hand in this file — and it
	// goes through `#toIds(fxDomain, false)`, i.e. `ids.get(...)` per entry.
	//
	// WHAT TO LOOK FOR
	//
	//   Chart 1 (VARCHAR, the control) — cells MUST read C, B, A. This is the
	//     same mechanism as facet-demo's reordered chart. If this one is wrong,
	//     the bug is not the one this page is about.
	//
	//   Chart 2 (DATE)      — cells SHOULD read Mar, Feb, Jan and TODAY READ
	//   Chart 3 (TIMESTAMP)   Jan, Feb, Mar. The fxDomain is silently discarded:
	//     every entry misses, #explicitDomain becomes empty, and
	//     updateDomainFromExtents falls through to first-appearance order.
	//
	// Note the failure is a SILENT WRONG ORDER, not an error. Nothing throws,
	// nothing warns, and the chart looks entirely reasonable — which is the
	// point, and why the panel below states the diagnosis in words rather than
	// leaving it to be inferred from three headings.
	//
	// The panel is the real assertion. Cell order tells you something is wrong;
	// the panel tells you it is object identity, by taking each dim value,
	// re-reading the SAME value through a SECOND query, and reporting whether
	// the Map finds it. That is the whole bug in one line per field.
	//
	// EACH CHART FACETS ON ITS OWN COLUMN. ScaleRegistry keys scales by name
	// plus type plus config and a facet scale is named `__facet__<fx>`, so two
	// containers faceting on one field share a BandScaleState and an fxDomain
	// on either reorders both (§25.3 bug 1, and facet-demo's note). Three
	// columns, three scales.

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

	// Same instants as the rows below. Written as Dates rather than strings on
	// purpose: supplying the CORRECT type still misses, which is what separates
	// this from an ordinary type mismatch.
	const dateDomain = [
		new Date(Date.UTC(2024, 2, 1)),
		new Date(Date.UTC(2024, 1, 1)),
		new Date(Date.UTC(2024, 0, 1))
	];
	const tsDomain = [
		new Date(Date.UTC(2024, 2, 1, 12)),
		new Date(Date.UTC(2024, 1, 1, 12)),
		new Date(Date.UTC(2024, 0, 1, 12))
	];

	/**
	 * The assertion this page exists for: take each value the dim holds, re-read
	 * the same value through a SECOND query, and ask the Map for it. A primitive
	 * round-trips; an object cannot.
	 */
	async function probe(field, table, column) {
		const identity = queryEngine.identityFor(field);
		// Uncached, so this is a genuinely SECOND read of the same values rather
		// than the dim's own result handed back — which is the entire point.
		const result = await queryEngine.query(
			`SELECT DISTINCT ${JSON.stringify(column)} AS v FROM ${JSON.stringify(table)} ` +
				`WHERE ${JSON.stringify(column)} IS NOT NULL ORDER BY 1`,
			{ cache: false }
		);
		const rows = [];
		for (let i = 0; i < result.numRows; i++) rows.push(result.get(i));

		const first = identity.values[0];
		const kind =
			first === null || first === undefined
				? 'empty'
				: typeof first === 'object'
					? `object(${first.constructor?.name ?? '?'})`
					: typeof first;

		const hits = rows.filter((r) => identity.ids.get(r.v) !== undefined).length;
		return {
			field,
			kind,
			count: identity.values.length,
			hits,
			total: rows.length,
			ok: rows.length > 0 && hits === rows.length
		};
	}

	onMount(async () => {
		try {
			// Three columns, three dims, three facet scales. Deliberately NOT in
			// alphabetical/chronological order in the source, so "first-appearance
			// order" and "dim order" are distinguishable from the reversal the
			// fxDomain asks for.
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
				) t(cat_ts, amount)`
			]);

			isLoaded = true;

			// After the marks have set up, so the dims exist. The panel reads the
			// engine's live FieldIdentity — the same object the scales hold.
			setTimeout(async () => {
				try {
					probes = await Promise.all([
						probe('cat_varchar', 'fx_varchar', 'cat_varchar'),
						probe('cat_date', 'fx_date', 'cat_date'),
						probe('cat_ts', 'fx_ts', 'cat_ts')
					]);
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
	<h1>DATE identity — §29.10</h1>
	<p class="lede">
		A dim over a DATE or TIMESTAMP column holds JS <code>Date</code> objects.
		<code>FieldIdentity.ids</code> is a Map keyed by the value, so it matches on reference identity
		and every value&rarr;id lookup crossing a query boundary misses. Faceting is the one public path
		to such a dim: <code>fx</code> builds a band scale with no type inference.
	</p>

	{#if error}
		<pre class="error">{error}</pre>
	{/if}

	<div class="panel">
		<h2>Round-trip probe</h2>
		{#if probes.length === 0}
			<p class="muted">Waiting for the dims to be built&hellip;</p>
		{:else}
			<table>
				<thead>
					<tr><th>field</th><th>dim value type</th><th>values</th><th>re-read hits</th><th /></tr>
				</thead>
				<tbody>
					{#each probes as p (p.field)}
						<tr class:bad={!p.ok}>
							<td><code>{p.field}</code></td>
							<td><code>{p.kind}</code></td>
							<td>{p.count}</td>
							<td>{p.hits} / {p.total}</td>
							<td>{p.ok ? 'round-trips' : 'MISSES — object identity'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="muted">
				Each row re-reads the field's own values through a second query and asks
				<code>identity.ids.get(v)</code> for each. A primitive hits; a <code>Date</code> cannot.
			</p>
		{/if}
	</div>

	{#if isLoaded}
		<h2>1. VARCHAR &mdash; the control. Cells must read C, B, A.</h2>
		<div class="chart">
			<ChartContainer xLabel="cat" yLabel="count" fx="cat_varchar" fxDomain={['C', 'B', 'A']}>
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

		<h2>2. DATE &mdash; should read Mar, Feb, Jan. Today reads Jan, Feb, Mar.</h2>
		<div class="chart">
			<ChartContainer xLabel="cat" yLabel="count" fx="cat_date" fxDomain={dateDomain}>
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

		<h2>3. TIMESTAMP &mdash; should read Mar, Feb, Jan. Today reads Jan, Feb, Mar.</h2>
		<div class="chart">
			<ChartContainer xLabel="cat" yLabel="count" fx="cat_ts" fxDomain={tsDomain}>
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
	.lede {
		max-width: 70ch;
		line-height: 1.5;
		color: #333;
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
		font-size: 0.85rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.3rem 0.9rem 0.3rem 0;
		border-bottom: 1px solid #e8e8e8;
	}
	tr.bad td {
		color: #b00020;
		font-weight: 600;
	}
	.muted {
		color: #666;
		font-size: 0.85rem;
		max-width: 70ch;
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
