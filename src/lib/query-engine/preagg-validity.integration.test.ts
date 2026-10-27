/**
 * Integration test: a preagg table serves brush queries only while what it
 * was built from still holds — the active brush, its bin dimensions and the
 * clauses baked into it. Runs QueryEngine end to end against native DuckDB
 * and checks returned rows against the same query on the base table.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import duckdb from 'duckdb';
import { column, count, isBetween, isIn, literal } from '@uwdata/mosaic-sql';
import { QueryEngine, type BrushActivation, type DuckDBConnection } from './QueryEngine';
import { buildBinExpr } from './sufficient-statistics';
import { FilterGroup } from './FilterGroup.svelte';
import type { MarkHandle } from './MarkHandle.svelte';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { buildQueryParts } from '$lib/components/marks/lifecycle/query-builder';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
//
// t: x = 0..999, cat alternates 'a'/'b', kind cycles 'p'/'q'/'r', g = x // 250.
// Chart A holds the brush on x. Chart B holds an aggregate mark, count by g,
// which is what preagg serves. Brush extents sit on whole numbers so the
// 1-px bins (domain [0, 1000] over 1000 px) select exactly the base rows.

const SEED_SQL = `
CREATE TABLE t AS
SELECT i::DOUBLE AS x,
       CASE WHEN i % 2 = 0 THEN 'a' ELSE 'b' END AS cat,
       CASE i % 3 WHEN 0 THEN 'p' WHEN 1 THEN 'q' ELSE 'r' END AS kind,
       i // 250 AS g
FROM range(1000) r(i)
`;

const BRUSH = 'interval-x-A';
const CHART_A = new Set(['dots-a']);
const MARK = 'bars-b';
const X_DIM = { columnRef: column('x'), domain: [0, 1000] as [number, number], pixelExtent: 1000 };

interface TestConn extends DuckDBConnection {
	queries: string[];
	/** While set, DDL waits on it: holds a preagg build in flight. */
	gate: Promise<void> | null;
	all(sql: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

function openConn(): TestConn {
	const db = new duckdb.Database(':memory:');
	const all = (sql: string) =>
		new Promise<Record<string, unknown>[]>((res, rej) =>
			db.all(sql, (e: Error | null, rows: Record<string, unknown>[]) => (e ? rej(e) : res(rows)))
		);
	const queries: string[] = [];
	const conn: TestConn = {
		queries,
		gate: null,
		all,
		// The handle stores whatever the connection returns, so plain rows will do
		async query(sql: string) {
			queries.push(sql);
			const rows = await all(sql);
			return rows.map((r) => ({ g: Number(r.g), n: Number(r.n) })) as never;
		},
		async exec(sql: string) {
			queries.push(sql);
			if (conn.gate) await conn.gate;
			await all(sql);
		},
		close: () =>
			new Promise<void>((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
	return conn;
}

let conn: TestConn;
let engine: QueryEngine;
let group: FilterGroup;
let handle: MarkHandle;

beforeEach(async () => {
	conn = openConn();
	await conn.all(SEED_SQL);
	engine = new QueryEngine(conn);
	group = new FilterGroup();
	group.setEngine(engine);

	const descriptor = {
		table: 't',
		baseTable: 't',
		parts: buildQueryParts({ g: column('g'), n: count() }, null, false),
		schema: new Map(),
		transformCompiler: new TransformCompiler([])
	};
	handle = engine.registerMark(MARK, descriptor, group);
	await settle(() => handle.updateParams({ sort: undefined, limit: undefined, filterNulls: null }));
});

afterEach(async () => {
	await engine.destroy();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run an action and wait for the mark's next result. */
async function settle(action: () => void): Promise<void> {
	const version = handle.dataVersion;
	action();
	await vi.waitFor(() => expect(handle.dataVersion).toBeGreaterThan(version));
}

function rows(): Array<[number, number]> {
	const result = handle.arrowTable as unknown as Array<{ g: number; n: number }>;
	return result.map((r): [number, number] => [r.g, r.n]).sort((a, b) => a[0] - b[0]);
}

async function expected(where: string): Promise<Array<[number, number]>> {
	const result = await conn.all(`SELECT g, count(*) AS n FROM t WHERE ${where} GROUP BY g`);
	return result
		.map((r): [number, number] => [Number(r.g), Number(r.n)])
		.sort((a, b) => a[0] - b[0]);
}

/** The SQL of the mark's last query (DDL excluded). */
function lastQuery(): string {
	return conn.queries.filter((q) => !q.startsWith('CREATE')).at(-1)!;
}

function creates(): string[] {
	return conn.queries.filter((q) => q.startsWith('CREATE TABLE IF NOT EXISTS "__dplot_preagg_'));
}

const brush = () => group.register(BRUSH, { excludeMarkIds: () => CHART_A });

/** Activate the brush on chart A, as its hover does. */
function activate(dims: BrushActivation[] = [X_DIM]): Promise<void> {
	return engine.activate(group, {
		sourceId: BRUSH,
		excludedByAll: CHART_A,
		dims: dims.map((d) => ({ kind: 'bin' as const, ...d }))
	});
}

function drag(b: ReturnType<typeof brush>, lo: number, hi: number): Promise<void> {
	return settle(() => b.update(isBetween(column('x'), [lo, hi]), [lo, hi]));
}

function toggle(field: string, values: string[], excludeMarkIds = new Set<string>()) {
	const consumer = group.registerToggle(field, { excludeMarkIds: () => excludeMarkIds });
	return settle(() => consumer.set(values.map((v) => [v])));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('preagg validity', () => {
	it('first hover with no brush clause, then drag: every drag frame reads the preagg table', async () => {
		await activate();
		const b = brush();

		for (const [lo, hi] of [
			[100, 399],
			[100, 599],
			[300, 899]
		]) {
			await drag(b, lo, hi);
			expect(lastQuery()).toContain('__dplot_preagg_');
			expect(rows()).toEqual(await expected(`x BETWEEN ${lo} AND ${hi}`));
		}
	});

	it('bakes a toggle on the brushed chart, and its bin bounds stay finite', async () => {
		// Excludes the same marks as the brush: the old inference took it for the brush
		await toggle('cat', ['a'], CHART_A);
		await activate();

		await drag(brush(), 100, 599);
		// Bins count from the window's start, one viewport (1000) below the domain.
		expect(lastQuery()).toContain('"__active0" BETWEEN 1100 AND 1599');
		expect(rows()).toEqual(await expected(`cat = 'a' AND x BETWEEN 100 AND 599`));
	});

	it('re-hover after a non-brush change rebuilds with the new filters', async () => {
		await activate();
		await toggle('cat', ['a']);
		await activate();

		await drag(brush(), 100, 599);
		expect(lastQuery()).toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`cat = 'a' AND x BETWEEN 100 AND 599`));
	});

	it('re-hover with nothing changed reuses the table', async () => {
		await toggle('cat', ['a']);
		await activate();
		await activate();

		expect(creates()).toHaveLength(1);
	});

	it('re-activating keeps the table while the view sits well inside its window, at fine enough bins', async () => {
		await activate(); // [0, 1000] at 1 px per unit: bins over [-1000, 2000]
		await activate([{ ...X_DIM, domain: [300, 1300] }]); // pan of under half a viewport
		await activate([{ ...X_DIM, pixelExtent: 500 }]); // smaller chart: coarser pixels
		expect(creates()).toHaveLength(1);

		await activate([{ ...X_DIM, domain: [600, 1600] }]); // pan past half a viewport
		expect(creates()).toHaveLength(2);
		await activate([{ ...X_DIM, domain: [-1000, 3000] }]); // zoom out past the window
		expect(creates()).toHaveLength(3);
		await activate([{ ...X_DIM, domain: [0, 500] }]); // zoom in: 2 px per unit
		expect(creates()).toHaveLength(4);

		await drag(brush(), 100, 399);
		expect(lastQuery()).toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`x BETWEEN 100 AND 399`));
	});

	it('the same filters added in a different order name the same table', async () => {
		await toggle('cat', ['a']);
		await toggle('kind', ['p']);
		await activate();

		// Remove and re-add cat: it moves to the end of the selection
		await toggle('cat', []);
		await toggle('cat', ['a']);
		await activate();

		expect(new Set(creates()).size).toBe(1);
		await drag(brush(), 100, 599);
		expect(lastQuery()).toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`cat = 'a' AND kind = 'p' AND x BETWEEN 100 AND 599`));
	});
});

describe('preagg validity: filter changes without a re-hover', () => {
	it('a changed non-brush clause sends the mark to the base table', async () => {
		await toggle('cat', ['a']);
		await activate();
		const b = brush();
		await drag(b, 100, 599);
		expect(lastQuery()).toContain('__dplot_preagg_');

		await toggle('cat', ['b']);
		expect(lastQuery()).not.toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`cat = 'b' AND x BETWEEN 100 AND 599`));

		await drag(b, 100, 699);
		expect(lastQuery()).not.toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`cat = 'b' AND x BETWEEN 100 AND 699`));
	});

	it('restoring the clause returns to the preagg table, with no new CREATE', async () => {
		await toggle('cat', ['a']);
		await activate();
		const b = brush();
		await toggle('cat', ['b']);
		await toggle('cat', ['a']);

		await drag(b, 100, 599);
		expect(lastQuery()).toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`cat = 'a' AND x BETWEEN 100 AND 599`));
		expect(creates()).toHaveLength(1);
	});

	it('a clause removed and re-added keeps the preagg table through the SQL check', async () => {
		await toggle('cat', ['a']);
		await toggle('kind', ['p']);
		await activate();
		const b = brush();

		// Removing cat clears its clause; re-adding moves it to the end of the selection
		await toggle('cat', []);
		await toggle('cat', ['a']);

		await drag(b, 100, 599);
		expect(lastQuery()).toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`cat = 'a' AND kind = 'p' AND x BETWEEN 100 AND 599`));
		expect(creates()).toHaveLength(1);
	});

	it('a toggle re-synced with the same values stays on the preagg table', async () => {
		await toggle('cat', ['a']);
		await activate();
		await toggle('cat', ['a']);

		await drag(brush(), 100, 599);
		expect(lastQuery()).toContain('__dplot_preagg_');

		// Re-hovering after a reference-only change does not rebuild either
		await activate();
		expect(creates()).toHaveLength(1);
	});

	it('a removed baked clause sends the mark to the base table, unfiltered', async () => {
		await toggle('cat', ['a']);
		await activate();
		const b = brush();
		await toggle('cat', []);

		await drag(b, 100, 599);
		expect(lastQuery()).not.toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`x BETWEEN 100 AND 599`));
	});

	it('an upsertManual filter added after the build is applied', async () => {
		await activate();
		const b = brush();
		await settle(() =>
			group.upsertManual('k', isIn(column('kind'), [literal('q')]), ['q'], new Set())
		);

		await drag(b, 100, 599);
		expect(lastQuery()).not.toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`kind = 'q' AND x BETWEEN 100 AND 599`));
	});

	it('hovering a Toggle-only chart leaves the brush table in place', async () => {
		await activate();
		const b = brush();
		await drag(b, 100, 599);
		expect(lastQuery()).toContain('__dplot_preagg_');
		const built = creates().length;

		// A Toggle has no bin dims, so activating it builds nothing, and it must
		// not drop the table of a mark it excludes, as a brush activation would.
		group.registerToggle('cat', { excludeMarkIds: () => new Set([MARK]) }).activate();

		await drag(b, 100, 699);
		expect(lastQuery()).toContain('__dplot_preagg_');
		expect(creates()).toHaveLength(built);
		expect(rows()).toEqual(await expected('x BETWEEN 100 AND 699'));
	});

	it('a parallel brush drag after an Interval1D hover is applied', async () => {
		await activate();
		await drag(brush(), 100, 599);
		const parallel = group.register('parallel-brush-x-C', { excludeMarkIds: () => new Set() });

		await settle(() => parallel.update(isBetween(column('x'), [0, 299]), [0, 299]));
		expect(lastQuery()).not.toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`x BETWEEN 100 AND 599 AND x BETWEEN 0 AND 299`));
	});

	it('a clause changed while the build is in flight is caught once the build lands', async () => {
		let release!: () => void;
		conn.gate = new Promise((r) => (release = r));
		const building = activate();

		await toggle('cat', ['a']);
		conn.gate = null;
		release();
		await building;

		await drag(brush(), 100, 599);
		expect(lastQuery()).not.toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`cat = 'a' AND x BETWEEN 100 AND 599`));
	});

	it('after a mismatch, drag frames skip rebuilding the SQL', async () => {
		await activate();
		const b = brush();
		await toggle('cat', ['a']);

		const rebuilds = vi.spyOn(group.selection, 'bakedPredicates');
		await drag(b, 100, 599);
		await drag(b, 100, 699);
		expect(rebuilds).not.toHaveBeenCalled();
	});

	describe('one table per source', () => {
		// A second brush on another chart (C), which also filters the mark.
		const BRUSH_C = 'interval-x-C';
		const CHART_C = new Set(['dots-c']);
		const brushC = () => group.register(BRUSH_C, { excludeMarkIds: () => CHART_C });
		const activateC = () =>
			engine.activate(group, {
				sourceId: BRUSH_C,
				excludedByAll: CHART_C,
				dims: [{ kind: 'bin', ...X_DIM }]
			});

		it('activating a second source leaves the first source’s table in place', async () => {
			await activate();
			await activateC();
			expect(creates()).toHaveLength(2);

			// Back on chart A: its table is still there, so no rebuild.
			await activate();
			expect(creates()).toHaveLength(2);
			await drag(brush(), 100, 599);
			expect(lastQuery()).toContain('__dplot_preagg_');
			expect(rows()).toEqual(await expected('x BETWEEN 100 AND 599'));
		});

		it('a source that excludes the mark leaves its other tables in place', async () => {
			await activate();
			await engine.activate(group, {
				sourceId: BRUSH_C,
				excludedByAll: new Set([MARK]),
				dims: [{ kind: 'bin', ...X_DIM }]
			});

			await drag(brush(), 100, 599);
			expect(lastQuery()).toContain('__dplot_preagg_');
			expect(creates()).toHaveLength(1);
		});

		it('the table that answers moves to the front, so the next frame rebuilds no SQL', async () => {
			// Activated in this order, A's table is checked first, and it bakes
			// C's clause, which moves on every frame of a drag on C.
			await activate();
			await activateC();
			const c = brushC();

			await drag(c, 100, 599);
			expect(lastQuery()).toContain('__dplot_preagg_');
			const rebuilds = vi.spyOn(group.selection, 'bakedPredicates');
			await drag(c, 100, 699);
			await drag(c, 200, 699);
			expect(rebuilds).not.toHaveBeenCalled();
			expect(rows()).toEqual(await expected('x BETWEEN 200 AND 699'));
		});

		it('destroying a source’s last registration forgets its tables', async () => {
			const c = brushC();
			await activateC();
			await activateC();
			expect(creates()).toHaveLength(1);

			c.destroy();
			// Forgotten, so activating again builds (CREATE TABLE IF NOT EXISTS) anew.
			await activateC();
			expect(creates()).toHaveLength(2);
		});
	});

	it('a channel named like a column of the table still builds and reads its brush table', async () => {
		// t has a column x; this mark's channel x is g. GROUP BY "x" would bind
		// to t.x rather than the channel, and the build would fail.
		const handleX = engine.registerMark(
			'bars-x',
			{
				table: 't',
				baseTable: 't',
				parts: buildQueryParts({ x: column('g'), n: count() }, null, false),
				schema: new Map(),
				transformCompiler: new TransformCompiler([])
			},
			group
		);
		handleX.updateParams({ sort: undefined, limit: undefined, filterNulls: null });
		await activate();
		expect(creates()).toHaveLength(2);

		const version = handleX.dataVersion;
		await drag(brush(), 100, 599);
		await vi.waitFor(() => expect(handleX.dataVersion).toBeGreaterThan(version));
		const query = conn.queries.filter((q) => !q.startsWith('CREATE') && q.includes('"x"')).at(-1)!;
		expect(query).toContain('__dplot_preagg_');
	});

	it('bins an integer column at a whole-number window start without DECIMAL overflow', async () => {
		// A SMALLINT minus a whole d0 stays an integer, and an integer times a
		// literal like 1.4107142857142858 (a DECIMAL to DuckDB) overflowed
		// DECIMAL(18). The bins must also equal the query-time Math.floor.
		await conn.all(`CREATE TABLE s AS SELECT (i - 63)::SMALLINT AS v FROM range(249) r(i)`);
		const { expr, d0, scaleFactor, bins } = buildBinExpr(column('v'), [-80, 200], 395);
		expect(Number.isInteger(d0)).toBe(true);
		const result = await conn.all(`SELECT v, ${expr} AS b FROM s`);
		for (const row of result) {
			const fine = Math.floor((Number(row.v) - d0) * scaleFactor);
			expect(Number(row.b)).toBe(fine < 0 ? -1 : fine >= bins ? bins : fine);
		}
	});

	describe('bin resolution', () => {
		// The brush's current view, as Interval1D reports it: [d0, d1, pixel extent].
		let view: [number, number, number];
		const outs = new Set<Float64Array>();
		const activateWithView = () =>
			engine.activate(group, {
				sourceId: BRUSH,
				excludedByAll: CHART_A,
				dims: [{ kind: 'bin', ...X_DIM }],
				view: (out) => {
					outs.add(out);
					out[0] = view[0];
					out[1] = view[1];
					out[2] = view[2];
				}
			});

		beforeEach(() => {
			view = [0, 1000, 1000];
			outs.clear();
		});

		it('a pan or a zoom out keeps the table; its bins are still at least a pixel wide', async () => {
			await activateWithView();
			const b = brush();

			view = [300, 1300, 1000]; // pan: same bin width
			await drag(b, 400, 799);
			expect(lastQuery()).toContain('__dplot_preagg_');
			expect(rows()).toEqual(await expected('x BETWEEN 400 AND 799'));

			view = [0, 2000, 1000]; // zoom out: bins finer than the new pixels
			await drag(b, 100, 1999);
			expect(lastQuery()).toContain('__dplot_preagg_');
			expect(rows()).toEqual(await expected('x BETWEEN 100 AND 1999'));
		});

		it('a brush reaching past the binned window reads the base table', async () => {
			await activateWithView(); // bins over [-1000, 2000]
			const b = brush();

			await drag(b, -1500, 499); // below the window: the bottom edge bin
			expect(lastQuery()).not.toContain('__dplot_preagg_');
			expect(rows()).toEqual(await expected('x BETWEEN -1500 AND 499'));

			await drag(b, -1000, 499); // back inside
			expect(lastQuery()).toContain('__dplot_preagg_');
			expect(rows()).toEqual(await expected('x BETWEEN -1000 AND 499'));
		});

		it('a deep zoom bins only the window: everything outside shares two edge bins', async () => {
			// 100 px per unit over [0, 10]: the full range would be 100,000 bins.
			await activate([{ ...X_DIM, domain: [0, 10] }]);
			const [create] = creates();
			const table = create.match(/"(__dplot_preagg_[0-9a-f]+)"/)![1];
			const [{ n }] = await conn.all(`SELECT count(*) AS n FROM "${table}"`);
			// x = 0..19 fall in the window [-10, 20], one bin each (all g = 0); 20..999
			// share the top edge bin, once per g. The full range would be 1,000 rows.
			expect(Number(n)).toBe(20 + 4);

			await drag(brush(), 2, 7);
			expect(lastQuery()).toContain('__dplot_preagg_');
			expect(rows()).toEqual(await expected('x BETWEEN 2 AND 7'));
		});

		it('a zoom in past the built resolution goes to the base table until a rebuild', async () => {
			await activateWithView();
			const b = brush();

			view = [0, 500, 1000]; // two pixels per built bin
			await drag(b, 100, 399);
			expect(lastQuery()).not.toContain('__dplot_preagg_');
			expect(rows()).toEqual(await expected('x BETWEEN 100 AND 399'));

			// What settling does: activate again with the current view.
			await engine.activate(group, {
				sourceId: BRUSH,
				excludedByAll: CHART_A,
				dims: [{ kind: 'bin', ...X_DIM, domain: [0, 500] }],
				view: (out) => {
					out[0] = view[0];
					out[1] = view[1];
					out[2] = view[2];
				}
			});
			await drag(b, 100, 349);
			expect(lastQuery()).toContain('__dplot_preagg_');
			expect(rows()).toEqual(await expected('x BETWEEN 100 AND 349'));
		});

		it('reads the view into the same array on every query', async () => {
			await activateWithView();
			const b = brush();
			await drag(b, 100, 599);
			await drag(b, 100, 699);
			expect(outs.size).toBe(1);
		});
	});
});
