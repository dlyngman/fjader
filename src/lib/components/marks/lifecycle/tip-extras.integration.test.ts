/**
 * Integration test: the statements that write a mark's tip expressions
 * (`tip=[("N", count())]`) into its tooltip table, run in native DuckDB: a
 * sidecar query, joined onto the mark's rows.
 *
 * The sidecar selects only the mark's non-aggregate channels and the tip
 * expressions. A SQL transform that reads the mark's value channel (an
 * implicit stack) must not run on it; a row filter must, since it decides which
 * source rows the aggregates see.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { avg, column, count, gt, literal } from '@uwdata/mosaic-sql';
import { filter, stackY, TransformCompiler } from '$lib/transforms';
import { assembleQuery, buildQueryParts, castReal, tipExtrasStatements } from './query-builder';
import type { MarkConfig } from '$lib/types';

interface DB {
	run(sql: string): Promise<void>;
	all(sql: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

function openDB(): DB {
	const db = new duckdb.Database(':memory:');
	return {
		run: (sql) => new Promise((res, rej) => db.run(sql, (e: Error | null) => (e ? rej(e) : res()))),
		all: (sql) =>
			new Promise((res, rej) =>
				db.all(sql, (e: Error | null, rows: Record<string, unknown>[]) => (e ? rej(e) : res(rows)))
			),
		close: () => new Promise((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
}

// rect_y(x1="start", x2="end", y=avg("v")): two intervals, three rows each.
const SEED_SQL = `
CREATE TABLE spans AS
SELECT * FROM (VALUES
	(0, 10, 1.0), (0, 10, 2.0), (0, 10, 6.0),
	(10, 20, 4.0), (10, 20, 5.0), (10, 20, 9.0)
) AS t("start", "end", v);
`;

const CONFIG: MarkConfig = { markType: 'recty', table: 'spans', x: 'x1', y: 'y2' };
const SELECT = { x1: column('start'), x2: column('end'), y2: castReal(avg('v')) };
const EXTRAS = { Rate: avg('v'), N: count() };

let db: DB;

beforeAll(async () => {
	db = openDB();
	await db.run(SEED_SQL);
});

afterAll(async () => {
	await db.close();
});

/** The mark's rows as the tooltip table holds them, with the extras merged in. */
async function tooltipRows(compiler: TransformCompiler): Promise<Record<string, unknown>[]> {
	const parts = buildQueryParts(SELECT, undefined, compiler.hasSQLTransforms());
	const markQuery = assembleQuery({ table: 'spans', parts, transformCompiler: compiler });
	await db.run(`CREATE OR REPLACE TABLE tip AS ${markQuery.toString()}`);

	const statements = tipExtrasStatements({
		tooltipTable: 'tip',
		table: 'spans',
		parts,
		tipExtras: EXTRAS,
		filter: [],
		transformCompiler: compiler
	});
	expect(statements).not.toBeNull();
	for (const statement of statements!) await db.run(statement);

	return db.all(`SELECT x1, "Rate", "N" FROM tip ORDER BY x1`);
}

describe('tipExtrasStatements', () => {
	it('computes extras on a mark with an implicit stack', async () => {
		const rows = await tooltipRows(new TransformCompiler([stackY()], CONFIG));
		expect(rows).toEqual([
			{ x1: 0, Rate: 3, N: 3 },
			{ x1: 10, Rate: 6, N: 3 }
		]);
	});

	it('applies a row filter to the extras, as the mark applies it', async () => {
		const compiler = new TransformCompiler(
			[filter(gt(column('v'), literal(1.5))), stackY()],
			CONFIG
		);
		const rows = await tooltipRows(compiler);
		expect(rows).toEqual([
			{ x1: 0, Rate: 4, N: 2 },
			{ x1: 10, Rate: 6, N: 3 }
		]);
	});
});
