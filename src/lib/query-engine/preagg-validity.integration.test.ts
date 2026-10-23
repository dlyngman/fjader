/**
 * Integration test: a preagg table serves brush queries only while what it
 * was built from still holds — the active brush, its bin dimensions and the
 * clauses baked into it. Runs QueryEngine end to end against native DuckDB
 * and checks returned rows against the same query on the base table.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import duckdb from 'duckdb';
import { column, count, isBetween, isIn, literal } from '@uwdata/mosaic-sql';
import { QueryEngine, type DuckDBConnection } from './QueryEngine';
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
	return {
		queries,
		all,
		// The handle stores whatever the connection returns, so plain rows will do
		async query(sql: string) {
			queries.push(sql);
			const rows = await all(sql);
			return rows.map((r) => ({ g: Number(r.g), n: Number(r.n) })) as never;
		},
		async exec(sql: string) {
			queries.push(sql);
			await all(sql);
		},
		close: () =>
			new Promise<void>((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
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

const brush = () => group.createBrush({ sourceId: BRUSH, excludeMarkIds: () => CHART_A });

function drag(b: ReturnType<typeof brush>, lo: number, hi: number): Promise<void> {
	return settle(() => b.update(isBetween(column('x'), [lo, hi]), [lo, hi]));
}

function toggle(field: string, values: string[], excludeMarkIds = new Set<string>()) {
	return settle(() =>
		group.syncToggle(
			field,
			values.length
				? isIn(
						column(field),
						values.map((v) => literal(v))
					)
				: null,
			values,
			{ excludeMarkIds: () => excludeMarkIds }
		)
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('preagg validity', () => {
	it('first hover with no brush clause, then drag: every drag frame reads the preagg table', async () => {
		await engine.activate(group, BRUSH, CHART_A, [X_DIM]);
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
		await engine.activate(group, BRUSH, CHART_A, [X_DIM]);

		await drag(brush(), 100, 599);
		expect(lastQuery()).toContain('"__active0" BETWEEN 100 AND 599');
		expect(rows()).toEqual(await expected(`cat = 'a' AND x BETWEEN 100 AND 599`));
	});

	it('re-hover after a non-brush change rebuilds with the new filters', async () => {
		await engine.activate(group, BRUSH, CHART_A, [X_DIM]);
		await toggle('cat', ['a']);
		await engine.activate(group, BRUSH, CHART_A, [X_DIM]);

		await drag(brush(), 100, 599);
		expect(lastQuery()).toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`cat = 'a' AND x BETWEEN 100 AND 599`));
	});

	it('re-hover with nothing changed reuses the table', async () => {
		await toggle('cat', ['a']);
		await engine.activate(group, BRUSH, CHART_A, [X_DIM]);
		await engine.activate(group, BRUSH, CHART_A, [X_DIM]);

		expect(creates()).toHaveLength(1);
	});

	it('re-activate with a new domain or pixel extent rebuilds with new bin meta', async () => {
		await engine.activate(group, BRUSH, CHART_A, [X_DIM]);
		await engine.activate(group, BRUSH, CHART_A, [{ ...X_DIM, domain: [0, 500] }]);
		await engine.activate(group, BRUSH, CHART_A, [
			{ ...X_DIM, domain: [0, 500], pixelExtent: 500 }
		]);

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
		await engine.activate(group, BRUSH, CHART_A, [X_DIM]);

		// Remove and re-add cat: it moves to the end of the selection
		await toggle('cat', []);
		await toggle('cat', ['a']);
		await engine.activate(group, BRUSH, CHART_A, [X_DIM]);

		expect(new Set(creates()).size).toBe(1);
		await drag(brush(), 100, 599);
		expect(lastQuery()).toContain('__dplot_preagg_');
		expect(rows()).toEqual(await expected(`cat = 'a' AND kind = 'p' AND x BETWEEN 100 AND 599`));
	});
});
