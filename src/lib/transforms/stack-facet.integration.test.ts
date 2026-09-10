/**
 * A facet cell is its own stack.
 *
 * `PARTITION BY band` alone pools rows from every cell that share a band value.
 * That was invisible for as long as it existed because every faceted bar chart
 * in the repo sets `x` and `fx` to the SAME field, which makes each partition a
 * single row and the pooling arithmetically a no-op — the §25.3 lesson again,
 * in a different component: the case where two things differ has to be BUILT
 * before a confusion between them can show.
 *
 * Both halves are checked here. The SQL shape says the partition key is right;
 * the DuckDB run says the numbers are, because the shape test would have passed
 * just as happily with the facet in the ORDER BY instead of the PARTITION BY.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import duckdb from 'duckdb';
import { Query, column } from '@uwdata/mosaic-sql';
import { stackY, normalize } from './index';

interface DB {
	run(s: string): Promise<void>;
	all(s: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}
function openDB(): DB {
	const db = new duckdb.Database(':memory:');
	return {
		run: (s: string) => new Promise((r, j) => db.run(s, (e: Error | null) => (e ? j(e) : r()))),
		all: (s: string) =>
			new Promise((r, j) =>
				db.all(s, (e: Error | null, x: Record<string, unknown>[]) => (e ? j(e) : r(x)))
			),
		close: () => new Promise((r, j) => db.close((e: Error | null) => (e ? j(e) : r())))
	};
}

/** A faceted, stacked select: two cells, and a band value present in both. */
function facetedQuery() {
	return Query.from('t').select({
		__facet: column('cell'),
		x: column('bucket'),
		fill: column('bucket'),
		y: column('n')
	});
}

describe('stack and normalize partition by the facet', () => {
	let db: DB;

	beforeEach(async () => {
		db = openDB();
		await db.run(`CREATE TABLE t (cell VARCHAR, bucket VARCHAR, n REAL)`);
		// 'lo' appears in both cells, which is the whole point: pooled, its
		// running total carries from one cell into the next.
		await db.run(`INSERT INTO t VALUES
			('c1', 'lo', 2), ('c2', 'hi', 1), ('c2', 'lo', 1), ('c3', 'hi', 2)`);
	});

	afterEach(async () => {
		await db.close();
	});

	it('puts __facet in the stack partition when the mark is faceted', () => {
		const out = stackY()
			.apply(facetedQuery(), { markType: 'bary', table: 't', x: 'x', y: 'y', fill: 'fill' })
			.toString();
		expect(out).toMatch(/PARTITION BY "x", "__facet"/);
	});

	it('leaves an unfaceted stack alone', () => {
		const q = Query.from('t').select({
			x: column('bucket'),
			fill: column('bucket'),
			y: column('n')
		});
		const out = stackY()
			.apply(q, { markType: 'bary', table: 't', x: 'x', y: 'y', fill: 'fill' })
			.toString();
		expect(out).toMatch(/PARTITION BY "x"/);
		expect(out).not.toContain('__facet');
	});

	it('starts every cell at zero, which is what the chart shows', async () => {
		const sql = stackY()
			.apply(facetedQuery(), { markType: 'bary', table: 't', x: 'x', y: 'y', fill: 'fill' })
			.toString();
		const rows = await db.all(`${sql} ORDER BY "__facet", "x"`);

		// One series per cell here, so every bar is the whole of its own cell:
		// y0 is 0 everywhere and y1 is that cell's own count.
		expect(rows.map((r) => Number(r.y0))).toEqual([0, 0, 0, 0]);
		expect(rows.map((r) => Number(r.y1))).toEqual([2, 1, 1, 2]);
	});

	it('pooled totals would have given every tied row the grand total', async () => {
		// Pins what the bug actually did, since it is worse than an offset:
		// ORDER BY over tied series values gives every peer the whole partition
		// sum, so no bar was right rather than some being shifted.
		const rows = await db.all(
			`SELECT cell, bucket, SUM(n) OVER (PARTITION BY bucket ORDER BY bucket) AS hi
			 FROM t ORDER BY cell, bucket`
		);
		expect(rows.map((r) => Number(r.hi))).toEqual([3, 3, 3, 3]);
	});

	it('normalizes within a cell, so each cell reaches 100', async () => {
		const sql = normalize({ by: 'y' })
			.apply(facetedQuery(), { markType: 'bary', table: 't', x: 'x', y: 'y', fill: 'fill' })
			.toString();
		const rows = await db.all(`${sql} ORDER BY "__facet", "x"`);
		expect(rows.every((r) => Number(r.y) === 100)).toBe(true);
	});
});
