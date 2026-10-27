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
		expect(lastQuery()).toContain('"__active0" BETWEEN 100 AND 599');
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

	it('re-activate with a new domain or pixel extent rebuilds with new bin meta', async () => {
		await activate();
		await activate([{ ...X_DIM, domain: [0, 500] }]);
		await activate([{ ...X_DIM, domain: [0, 500], pixelExtent: 500 }]);

		// Each change rebuilds. The last has the first one's bins (1 unit per px),
		// so its SQL hashes to the first table.
		expect(creates()).toHaveLength(3);
		expect(new Set(creates()).size).toBe(2);

		// 1 px per unit again: bins align with the base rows
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
});
