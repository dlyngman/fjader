/**
 * Integration test: the statement that writes a mark's tip expressions
 * (`tip=[("N", count())]`) into its tooltip table, run in native DuckDB: the
 * table rebuilt with a sidecar query joined onto the mark's rows.
 *
 * The sidecar selects only the mark's non-aggregate channels and the tip
 * expressions. A SQL transform that reads the mark's value channel (an
 * implicit stack) must not run on it; a row filter must, since it decides which
 * source rows the aggregates see. Each extra keeps its own type, and the rows
 * keep their order.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { avg, column, count, gt, literal, max, min } from '@uwdata/mosaic-sql';
import { filter, stackY, TransformCompiler } from '$lib/transforms';
import {
	assembleQuery,
	buildQueryParts,
	castReal,
	tipExtrasStatement,
	type QueryParts
} from './query-builder';
import type { MarkConfig } from '$lib/types';

interface DB {
	run(sql: string): Promise<void>;
	all(sql: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

function openDB(): DB {
	const db = new duckdb.Database(':memory:');
	// One connection, as the tooltip table is TEMP and lives on its connection.
	const conn = db.connect();
	return {
		run: (sql) =>
			new Promise((res, rej) => conn.run(sql, (e: Error | null) => (e ? rej(e) : res()))),
		all: (sql) =>
			new Promise((res, rej) =>
				conn.all(sql, (e: Error | null, rows: Record<string, unknown>[]) =>
					e ? rej(e) : res(rows)
				)
			),
		close: () => new Promise((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
}

const SEED_SQL = `
-- rect_y(x1="start", x2="end", y=avg("v")): two intervals, three rows each.
CREATE TABLE spans AS
SELECT * FROM (VALUES
	(0, 10, 1.0), (0, 10, 2.0), (0, 10, 6.0),
	(10, 20, 4.0), (10, 20, 5.0), (10, 20, 9.0)
) AS t("start", "end", v);

-- bar_y(x="k", y=avg("v")) with a NULL category.
CREATE TABLE cats AS
SELECT * FROM (VALUES ('a', 1.0), ('a', 3.0), (NULL, 5.0), (NULL, 7.0)) AS t(k, v);

-- Dates, timestamps and text per category.
CREATE TABLE events AS
SELECT * FROM (VALUES
	('a', 1.0, DATE '2024-01-05', TIMESTAMP '2024-01-05 10:30:00', 'zeta'),
	('a', 2.0, DATE '2024-03-01', TIMESTAMP '2024-03-01 08:00:00', 'alpha'),
	('b', 3.0, DATE '2024-02-10', TIMESTAMP '2024-02-10 12:00:00', 'mid')
) AS t(k, v, d, ts, name);
`;

const SPANS: MarkConfig = { markType: 'recty', table: 'spans', x: 'x1', y: 'y2' };
const SPANS_SELECT = { x1: column('start'), x2: column('end'), y2: castReal(avg('v')) };
const BARS: MarkConfig = { markType: 'bary', table: 'cats', x: 'x', y: 'y' };
const BARS_SELECT = { x: column('k'), y: castReal(avg('v')) };

let db: DB;

beforeAll(async () => {
	db = openDB();
	await db.run(SEED_SQL);
});

afterAll(async () => {
	await db.close();
});

/**
 * Write the mark's tooltip table (TEMP, as the lifecycle writes it, in `order`)
 * and merge `extras` into it with the statement the lifecycle runs.
 */
async function writeTooltipTable(
	table: string,
	select: Record<string, unknown>,
	compiler: TransformCompiler,
	extras: Record<string, unknown>,
	order = ''
): Promise<void> {
	const parts: QueryParts = buildQueryParts(select, undefined, compiler.hasSQLTransforms());
	const markQuery = assembleQuery({ table, parts, transformCompiler: compiler });
	await db.run(`CREATE OR REPLACE TEMP TABLE tip AS ${markQuery.toString()} ${order}`);

	const statement = tipExtrasStatement({
		tooltipTable: 'tip',
		table,
		parts,
		tipExtras: extras,
		filter: [],
		transformCompiler: compiler
	});
	expect(statement).not.toBeNull();
	await db.run(statement!);
}

describe('tipExtrasStatement', () => {
	const RATE_N = { Rate: avg('v'), N: count() };

	it('computes extras on a mark with an implicit stack', async () => {
		const compiler = new TransformCompiler([stackY()], SPANS);
		await writeTooltipTable('spans', SPANS_SELECT, compiler, RATE_N);
		expect(await db.all(`SELECT x1, "Rate", "N"::INTEGER AS "N" FROM tip ORDER BY x1`)).toEqual([
			{ x1: 0, Rate: 3, N: 3 },
			{ x1: 10, Rate: 6, N: 3 }
		]);
	});

	it('applies a row filter to the extras, as the mark applies it', async () => {
		const compiler = new TransformCompiler(
			[filter(gt(column('v'), literal(1.5))), stackY()],
			SPANS
		);
		await writeTooltipTable('spans', SPANS_SELECT, compiler, RATE_N);
		expect(await db.all(`SELECT x1, "Rate", "N"::INTEGER AS "N" FROM tip ORDER BY x1`)).toEqual([
			{ x1: 0, Rate: 4, N: 2 },
			{ x1: 10, Rate: 6, N: 3 }
		]);
	});

	it('writes extras to a row whose key is NULL', async () => {
		await writeTooltipTable('cats', BARS_SELECT, new TransformCompiler([], BARS), { N: count() });
		expect(await db.all(`SELECT x, "N"::INTEGER AS "N" FROM tip ORDER BY x NULLS LAST`)).toEqual([
			{ x: 'a', N: 2 },
			{ x: null, N: 2 }
		]);
	});

	it('gives each extra its own type: dates, timestamps and text', async () => {
		const compiler = new TransformCompiler([], { ...BARS, table: 'events' });
		await writeTooltipTable('events', BARS_SELECT, compiler, {
			Latest: max('d'),
			At: max('ts'),
			First: min('name'),
			N: count()
		});
		const types = await db.all(
			`SELECT column_name AS name, column_type AS type FROM (DESCRIBE tip)
			 WHERE column_name IN ('Latest', 'At', 'First', 'N') ORDER BY column_name`
		);
		expect(types).toEqual([
			{ name: 'At', type: 'TIMESTAMP' },
			{ name: 'First', type: 'VARCHAR' },
			{ name: 'Latest', type: 'DATE' },
			{ name: 'N', type: 'BIGINT' }
		]);
		const rows = await db.all(
			`SELECT x, strftime("Latest", '%Y-%m-%d') AS latest, strftime("At", '%Y-%m-%d %H:%M') AS at,
			 "First", "N"::INTEGER AS "N" FROM tip ORDER BY x`
		);
		expect(rows).toEqual([
			{ x: 'a', latest: '2024-03-01', at: '2024-03-01 08:00', First: 'alpha', N: 2 },
			{ x: 'b', latest: '2024-02-10', at: '2024-02-10 12:00', First: 'mid', N: 1 }
		]);
	});

	it('keeps the rows in the order they were written', async () => {
		// Enough categories that a join would come back in its own order, written
		// in an order that is not the join's (as a table sorted by x is).
		await db.run(`
			CREATE OR REPLACE TABLE many AS
			SELECT (i * 7919) % 5000 AS k, i::DOUBLE AS v FROM range(20000) t(i)
		`);
		const compiler = new TransformCompiler([], { ...BARS, table: 'many' });
		await writeTooltipTable('many', BARS_SELECT, compiler, { N: count() }, 'ORDER BY x DESC');
		const keys = (await db.all(`SELECT x FROM tip`)).map((r) => Number(r.x));
		expect(keys).toEqual(Array.from({ length: 5000 }, (_, i) => 4999 - i));
	});
});
