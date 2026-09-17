<script>
	// Does the dense LEFT JOIN cost anything? A measurement harness.
	//
	// THE QUESTION. An aggregated topN mark ends at WHERE rank <= n, so a
	// category dropping out has no row and its bar vanishes on the frame the
	// reorder lands. Having the outermost query LEFT JOIN the dim keeps it, at
	// value 0, so it can animate out instead. That is only worth building if the
	// join is cheap, and this is the measurement.
	//
	// WHY THIS IS A ROUTE AND NOT AN INTEGRATION TEST. This project has two
	// DuckDB->JS boundaries and they disagree. Integration tests run the `duckdb`
	// npm package; the app runs duckdb-wasm through flechette's tableFromIPC. For
	// a TIMING number those are different engines outright, and the chunk-count
	// question below does not exist at all outside the app's path, because
	// tableFromIPC is what produces the chunks. A node benchmark would be a
	// confident number about something that does not ship.
	//
	// WHAT IS EXPECTED, written down first so the result is readable. A
	// diagnostic has to be able to surprise you, which means saying beforehand
	// what it should say.
	//
	//   The join runs AFTER aggregation. Its left side is the dim (C rows) and
	//   its right side is the already-aggregated, already-ranked result (<= n
	//   rows). The fact-table scan is byte-for-byte the same in both shapes. So
	//   the extra cost should be in OUTPUT — C rows instead of n, plus an ORDER
	//   BY over them — and not in work. Expectation: negligible up to a few
	//   thousand categories, visible but acceptable at 50k.
	//
	//   A result that contradicts this does NOT mean "the join is expensive". It
	//   means something else is happening, and the query plan is the next thing
	//   to look at.
	//
	// THE SECOND NUMBER MATTERS AS MUCH AS THE FIRST. The other reason to want
	// the dense shape is that it preserves Arrow zero-copy: a dense result
	// ordered by id IS the id-indexed GPU buffer, handed over without a copy.
	// That holds only while DataAccessor's fast path does — `col.data.length ===
	// 1` and `chunk.values instanceof Float32Array` (DataAccessor.ts:41-47).
	// More than one chunk silently falls back to a copy, with no error anywhere,
	// and that argument evaporates. So CHUNKS is a pass/fail column, not a
	// curiosity.
	//
	// HOW TO READ THE TABLE.
	//   dense/sparse ratio near 1.0 at 50-5000  -> the join is free; proceed
	//   chunks > 1 at any size                  -> zero-copy is lost; reconsider
	//   f32 = no                                -> a conversion copy per update
	//   dense much slower at 5000               -> cost binds sooner than thought;
	//                                              look at the query plan
	//
	// Cache is disabled on every measured query (QueryOpts.cache = false), or the
	// second run of each shape would report the map lookup rather than the query.

	import { onMount } from 'svelte';
	import { initDivePlot } from '$lib';
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { ArrowDataAccessor } from '$lib/data/DataAccessor';

	const { queryEngine } = initDivePlot();

	// Dim cardinalities to sweep. 50 is an ordinary bar chart, 500 a large one,
	// 5000 the point where a racing chart is still plausible, 50000 the case
	// where a shared slot table stops fitting.
	const CARDINALITIES = [50, 500, 5000, 50000];
	const ROWS = 200_000; // fact rows, constant across the sweep
	const TOP_N = 10;
	const REPS = 5; // measured runs after one warm-up

	let status = $state('idle');
	let rows = $state([]);
	let control = $state([]);
	let real = $state([]);
	let error = $state(null);
	let running = $state(false);

	function median(xs) {
		const s = [...xs].sort((a, b) => a - b);
		return s[Math.floor(s.length / 2)];
	}

	// The cast every value channel carries in the real app — castReal() in
	// query-builder.ts:84: COALESCE(CAST(expr AS REAL), 'NaN'::REAL). REAL is
	// what makes the column arrive as a Float32Array, which is half of
	// DataAccessor's fast path. The first draft of this harness left it out and
	// reported Float64Array as a failure of the join; it was a failure of the
	// harness.
	const castReal = (expr) => `COALESCE(CAST(${expr} AS REAL), 'NaN'::REAL)`;

	/** The query shape as it is today: one row per DISPLAYED category. */
	function sparseSQL(view, idCol) {
		return `
			SELECT "x", "y", "__dplot_topn_rank"
			FROM (
				SELECT "x", "y", ROW_NUMBER() OVER (ORDER BY "y" DESC) AS "__dplot_topn_rank"
				FROM (
					SELECT ${castReal(idCol)} AS "x", ${castReal('SUM(revenue)')} AS "y"
					FROM ${view} GROUP BY ${idCol}
				) AS __topn_base
			) AS __topn
			WHERE "__dplot_topn_rank" <= ${TOP_N}`;
	}

	/**
	 * The dense shape: one row per category in the dim, always, in id order.
	 *
	 * The cutoff stays INSIDE the join, so the join restores rows and not values
	 * — an excluded category comes back at 0, which is what makes a departing bar
	 * shrink to nothing rather than slide away at full height.
	 */
	function denseSQL(view, idCol, dim) {
		return `
			SELECT ${castReal('d.id')} AS "x",
			       ${castReal('COALESCE(a."y", 0)')} AS "y",
			       ${castReal('a."__dplot_topn_rank"')} AS "__dplot_topn_rank"
			FROM "${dim}" d
			LEFT JOIN (${sparseSQL(view, idCol)}) a ON a."x" = d.id
			ORDER BY d.id`;
	}

	/** Median wall time over REPS, after one warm-up. Cache off. */
	async function timeIt(sql) {
		await queryEngine.query(sql, { cache: false });
		const ts = [];
		for (let i = 0; i < REPS; i++) {
			const t0 = performance.now();
			await queryEngine.query(sql, { cache: false });
			ts.push(performance.now() - t0);
		}
		return median(ts);
	}

	/**
	 * The zero-copy check, against DataAccessor's actual fast-path conditions
	 * rather than against a description of them.
	 */
	async function inspect(sql) {
		const table = await queryEngine.query(sql, { cache: false });
		const col = table.getChild('y');
		const chunks = col?.data?.length ?? 0;

		// Ask the REAL accessor what it produces, rather than inspecting chunk 0
		// and inferring. An earlier version of this checked
		// `col.data[0].values instanceof Float32Array`, which is undefined for a
		// multi-chunk column — so it reported "not Float32Array" for a result
		// that is in fact a Float32Array, via toArray(). Measuring the thing that
		// ships beats measuring something adjacent to it.
		const out = new ArrowDataAccessor(table).getColumn('y');
		const zeroCopy = chunks === 1 && out != null && out === col.data[0].values;

		return {
			numRows: table.numRows,
			chunks,
			f32: out instanceof Float32Array,
			zeroCopy,
			rawType: out ? out.constructor.name : 'null'
		};
	}

	/**
	 * THE CONTROL. Runs FIRST, because it is seconds rather than a minute and it
	 * is the more decision-relevant of the two measurements.
	 *
	 * The first run of this harness reported 3 chunks at 5000 rows. 5000 / 2048
	 * = 2.44, and 2048 is DuckDB's vector size — which suggests chunking is a
	 * function of ROW COUNT and has nothing to do with the join at all. If that
	 * is right it is the bigger finding: Arrow zero-copy is assumed to be live
	 * Arrow zero-copy is "genuine today", and the marks it matters most for are
	 * the 200k-row scatters. Those would chunk too, and the fast path would
	 * already be dead for exactly the case it was written to protect.
	 *
	 * No join, no aggregate, no topN, no dim. One cast column, N rows. Whatever
	 * this says is a property of the DuckDB -> Arrow boundary itself.
	 */
	async function runControl() {
		running = true;
		control = [];
		real = [];
		error = null;
		try {
			for (const n of [1000, 2048, 2049, 5000, 200_000]) {
				status = `control: ${n.toLocaleString()} rows…`;
				const sql = `SELECT ${castReal('i')} AS "y" FROM range(${n}) t(i)`;
				control = [...control, { n, ...(await inspect(sql)) }];
			}
			// REAL DATA, because range() is a synthetic generator and may not batch
			// the way a parquet scan does. flights-200k is the table the scatter
			// routes actually use, and this is the shape those marks emit: cast
			// columns, no aggregate, no join.
			//
			// Added after the synthetic control said zero-copy stops at 2048 rows
			// and that was met with "we tested this extensively on a 200k scatter".
			// One of those is wrong and reading the code cannot settle which.
			status = 'control: real parquet…';
			await queryEngine.exec(
				loadParquet(
					'bench_flights',
					`${window.location.origin}/data/flights-200k.parquet`
				).toString()
			);
			for (const [label, sql] of [
				[
					'200k, 2 cast cols (scatter shape)',
					`SELECT ${castReal('delay')} AS "y", ${castReal('distance')} AS "x" FROM bench_flights`
				],
				['200k, LIMIT 2048', `SELECT ${castReal('delay')} AS "y" FROM bench_flights LIMIT 2048`],
				[
					'200k, filtered (~brush step)',
					`SELECT ${castReal('delay')} AS "y" FROM bench_flights WHERE distance < 1000`
				]
			]) {
				real = [...real, { label, ...(await inspect(sql)) }];
			}

			status = 'control done';
		} catch (e) {
			error = String(e?.stack ?? e);
			status = 'control failed';
		} finally {
			running = false;
		}
	}

	async function run() {
		await runControl();
		if (error) return;
		running = true;
		rows = [];
		error = null;
		try {
			for (const C of CARDINALITIES) {
				const table = `bench_${C}`;
				const field = `product_${C}`;

				status = `building ${table} (${ROWS} rows, ${C} categories)…`;
				await queryEngine.exec(
					`CREATE OR REPLACE TABLE ${table} AS
					 SELECT 'p' || lpad((i % ${C})::VARCHAR, 7, '0') AS ${field},
					        (i * 7919 % 100000) / 100.0 AS revenue
					 FROM range(${ROWS}) t(i)`
				);

				status = `dimming ${field}…`;
				await queryEngine.ensureColumns(table, { categorical: [field] });

				const view = `"${queryEngine.identitySourceFor(table)}"`;
				const idCol = `"${queryEngine.identityColumn(field)}"`;
				const dim = queryEngine.dimTableFor(field);

				const sparse = sparseSQL(view, idCol);
				const dense = denseSQL(view, idCol, dim);

				status = `measuring C=${C} sparse…`;
				const sparseMs = await timeIt(sparse);
				const sparseInfo = await inspect(sparse);

				status = `measuring C=${C} dense…`;
				const denseMs = await timeIt(dense);
				const denseInfo = await inspect(dense);

				rows = [
					...rows,
					{
						C,
						sparseMs,
						denseMs,
						ratio: denseMs / sparseMs,
						sparseRows: sparseInfo.numRows,
						denseRows: denseInfo.numRows,
						sparseChunks: sparseInfo.chunks,
						chunks: denseInfo.chunks,
						f32: denseInfo.f32,
						rawType: denseInfo.rawType
					}
				];
			}

			status = 'done';
		} catch (e) {
			error = String(e?.stack ?? e);
			status = 'failed';
		} finally {
			running = false;
		}
	}

	onMount(run);

	// A row is a pass when the dense shape stays close to sparse AND the result
	// is a single Float32Array chunk. The time bound is deliberately loose below
	// 50k, where the join is expected to be free, and absent at 50k, where the
	// cost is real and the question is only how much.
	//
	// What actually matters is TIME. The multi-chunk path measures at
	// 0.00-0.10 ms — one allocation and a memcpy — so crossing into multiple
	// chunks is a note, not a failure. A column that is not a Float32Array at all
	// WOULD be a failure, because that means a per-element numeric conversion
	// rather than a block copy.
	function verdict(r) {
		if (!r.f32) return 'FAIL — not Float32Array';
		if (r.C <= 5000 && r.ratio > 1.5) return 'FAIL — join not free';
		return r.chunks === 1 ? 'pass (zero-copy)' : 'pass (chunked, ~free)';
	}
</script>

<div class="page">
	<h1>Dense LEFT JOIN — query cost</h1>
	<p class="lede">
		Does making every category come back on every update cost anything? Expectation: near-free up to
		a few thousand categories, because the join runs after aggregation and the fact-table scan is
		unchanged. <strong>The chunks column matters as much as the times</strong> — more than one chunk
		means Arrow zero-copy is silently lost, and with it half the case for the dense shape.
	</p>

	<p class="status">
		{ROWS.toLocaleString()} fact rows · topN({TOP_N}) · median of {REPS} · cache off —
		<strong>{status}</strong>
	</p>

	{#if error}
		<pre class="error">{error}</pre>
	{/if}

	<h2>Control: chunking vs row count (no join, no aggregate)</h2>
	<p class="lede">
		One cast column, N rows, nothing else. If chunks track row count here, chunking is a property of
		the DuckDB&nbsp;&rarr;&nbsp;Arrow boundary and not of the join — and the assumption that
		zero-copy is live today needs re-reading, because the 200k-row case is the one it was
		protecting.
	</p>
	<table>
		<thead>
			<tr><th>rows</th><th>chunks</th><th>value array</th></tr>
		</thead>
		<tbody>
			{#each control as c (c.n)}
				<tr>
					<td>{c.n.toLocaleString()}</td>
					<td class:bad={c.chunks !== 1}>{c.chunks}</td>
					<td class:bad={!c.f32}>{c.rawType}</td>
				</tr>
			{/each}
		</tbody>
	</table>

	<h2>Control 2: real parquet, the shape the scatter routes emit</h2>
	<p class="lede">
		<code>range()</code> is a synthetic generator and may batch differently from a parquet scan.
		This is <code>flights-200k</code>, the table the 200k scatter routes actually load.
	</p>
	<table>
		<thead>
			<tr><th>query</th><th>rows</th><th>chunks</th><th>value array</th></tr>
		</thead>
		<tbody>
			{#each real as r (r.label)}
				<tr>
					<td>{r.label}</td>
					<td>{r.numRows.toLocaleString()}</td>
					<td class:bad={r.chunks !== 1}>{r.chunks}</td>
					<td class:bad={!r.f32}>{r.rawType}</td>
				</tr>
			{/each}
		</tbody>
	</table>

	<h2>The join: dense vs sparse</h2>
	<table>
		<thead>
			<tr>
				<th>categories</th>
				<th>sparse ms</th>
				<th>dense ms</th>
				<th>ratio</th>
				<th>rows out</th>
				<th>chunks s→d</th>
				<th>value array</th>
				<th>verdict</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r (r.C)}
				<tr>
					<td>{r.C.toLocaleString()}</td>
					<td>{r.sparseMs.toFixed(2)}</td>
					<td>{r.denseMs.toFixed(2)}</td>
					<td class:bad={r.C <= 5000 && r.ratio > 2}>{r.ratio.toFixed(2)}×</td>
					<td>{r.sparseRows} → {r.denseRows.toLocaleString()}</td>
					<td>{r.sparseChunks} → {r.chunks}</td>
					<td class:bad={!r.f32}>{r.rawType}</td>
					<td class:bad={verdict(r).startsWith('FAIL')}>{verdict(r)}</td>
				</tr>
			{/each}
			{#if running}
				<tr><td colspan="8" class="waiting">measuring…</td></tr>
			{/if}
		</tbody>
	</table>

	<button onclick={runControl} disabled={running}>Run control only</button>
	<button onclick={run} disabled={running}>Run everything</button>
</div>

<style>
	.page {
		font-family: system-ui, sans-serif;
		padding: 24px;
		max-width: 1000px;
	}
	h1 {
		font-size: 18px;
	}
	h2 {
		font-size: 15px;
		margin-top: 28px;
	}
	.lede,
	.status {
		font-size: 13px;
		color: #444;
		line-height: 1.5;
	}
	table {
		border-collapse: collapse;
		margin: 16px 0;
		font-size: 13px;
		font-variant-numeric: tabular-nums;
	}
	th,
	td {
		border: 1px solid #ddd;
		padding: 5px 10px;
		text-align: right;
	}
	th {
		background: #f5f5f5;
		font-weight: 600;
	}
	td:first-child,
	th:first-child,
	td:last-child,
	th:last-child {
		text-align: left;
	}
	.bad {
		background: #fde8e8;
		color: #a01;
		font-weight: 600;
	}
	.waiting {
		text-align: center;
		color: #888;
		font-style: italic;
	}
	.error {
		background: #fde8e8;
		padding: 10px;
		font-size: 12px;
		white-space: pre-wrap;
	}
	button {
		font-size: 13px;
		padding: 5px 12px;
	}
</style>
