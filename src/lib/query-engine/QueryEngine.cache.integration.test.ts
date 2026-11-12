/**
 * Integration test: the query cache against a dim that grows.
 *
 * A mark's query reads dim tables (dense padding pads every category the dim
 * holds), and a dim grows after the first queries run: a topN mark reserving
 * its Other, another table folding in. The SQL text stays the same, so a cache
 * keyed by text alone served the result from before the dim grew. On
 * /test/top-n that was a 44-row result where the dim gave 60, so the row set
 * changed between updates and the bars snapped instead of morphing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import duckdb from 'duckdb';
import { QueryEngine, type DuckDBConnection } from './QueryEngine';

interface TestConn extends DuckDBConnection {
	queries: string[];
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
		async query(sql: string) {
			queries.push(sql);
			const rows = (await all(sql)).map((r) =>
				Object.fromEntries(
					Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
				)
			);
			return Object.assign(rows, { numRows: rows.length, get: (i: number) => rows[i] }) as never;
		},
		async exec(sql: string) {
			queries.push(sql);
			await new Promise<void>((res, rej) =>
				db.exec(sql, (e: Error | null) => (e ? rej(e) : res()))
			);
		},
		close: () =>
			new Promise<void>((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
}

let conn: TestConn;
let engine: QueryEngine;

beforeEach(async () => {
	conn = openConn();
	await conn.exec!(`
		CREATE TABLE t AS SELECT * FROM (VALUES ('a'), ('b'), ('a')) AS v(cat);
		CREATE TABLE u AS SELECT * FROM (VALUES ('b'), ('c')) AS v(cat);
	`);
	engine = new QueryEngine(conn);
	await engine.ensureColumns('t', { categorical: ['cat'] });
});

afterEach(async () => {
	await engine.destroy();
});

/** Rows in the dim, through the cached path a mark's query takes. */
async function dimRows(): Promise<number> {
	const sql = `SELECT COUNT(*)::INT AS n FROM "${engine.dimTableFor('cat')}"`;
	const table = (await engine.query(sql, { callerId: 'mark' })) as unknown as {
		get(i: number): { n: number };
	};
	return table.get(0).n;
}

/** How many times the connection ran this SQL. */
const runs = (sql: string) => conn.queries.filter((q) => q === sql).length;

describe('QueryEngine query cache', () => {
	it('serves a repeated query from the cache while the dims stay the same', async () => {
		expect(await dimRows()).toBe(2);
		expect(await dimRows()).toBe(2);
		expect(runs(`SELECT COUNT(*)::INT AS n FROM "${engine.dimTableFor('cat')}"`)).toBe(1);
	});

	it('runs the query again once an Other is reserved in the dim', async () => {
		expect(await dimRows()).toBe(2);
		await engine.acquireSyntheticIdentity('cat', 'Other');
		expect(await dimRows()).toBe(3);
	});

	it('runs the query again once another table folds new values into the dim', async () => {
		expect(await dimRows()).toBe(2);
		await engine.ensureColumns('u', { categorical: ['cat'] });
		expect(await dimRows()).toBe(3);
	});
});
