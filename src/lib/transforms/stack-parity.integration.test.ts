/**
 * Integration test: SQL stackY/stackX and JS stackY/stackX must produce
 * identical cumulative offsets, including offset modes and NaN-gap
 * semantics (a NaN row's own y0/y1 become NaN, but it must not poison the
 * running total for later rows in the same band).
 *
 * Runs the real query assembly path (buildQueryParts + assembleQuery +
 * TransformCompiler) against native DuckDB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { column, sum, eq, literal, type ExprNode } from '@uwdata/mosaic-sql';
import { stackY, stackX, TransformCompiler } from './index';
import {
	buildQueryParts,
	assembleQuery,
	castReal
} from '$lib/components/marks/lifecycle/query-builder';
import { ColumnDataAccessor, type DataAccessor } from '$lib/data/DataAccessor';
import type { MarkConfig } from '$lib/types';

// ---------------------------------------------------------------------------
// DuckDB helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fixture: month/category/value, plus a NaN row to exercise gap semantics.
// ---------------------------------------------------------------------------

const SEED_SQL = `
CREATE TABLE stacked AS
SELECT * FROM (VALUES
	('Jan', 'North', 10.0), ('Jan', 'South', 20.0),
	('Feb', 'North', 15.0), ('Feb', 'South', 25.0),
	('Mar', 'North', 5.0),  ('Mar', 'South', 7.0)
) AS t(month, series, value);

CREATE TABLE stacked_nan AS
SELECT * FROM (VALUES
	('Jan', 'A', 10.0), ('Jan', 'B', 5.0),
	('Feb', 'A', NULL),  ('Feb', 'B', 15.0),
	('Mar', 'A', 20.0), ('Mar', 'B', 8.0)
) AS t(month, series, value);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowsToAccessor(rows: Record<string, unknown>[]): DataAccessor {
	const columns: Record<string, unknown[]> = {};
	for (const row of rows) {
		for (const [k, v] of Object.entries(row)) {
			(columns[k] ??= []).push(v);
		}
	}
	return new ColumnDataAccessor(columns, rows.length);
}

function accessorToRows(data: DataAccessor): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	for (let i = 0; i < data.length; i++) {
		const row: Record<string, unknown> = {};
		for (const col of data.columnNames) {
			row[col] = data.getColumn(col)![i];
		}
		rows.push(row);
	}
	return canonical(rows);
}

function normalizeVal(v: unknown): unknown {
	if (typeof v === 'bigint') return Number(v);
	if (typeof v === 'number') {
		if (Number.isNaN(v)) return 'NaN';
		return Math.round(v * 1e3) / 1e3;
	}
	return v;
}

function canonical(rows: Record<string, unknown>[]): Record<string, unknown>[] {
	return rows
		.map((r) =>
			Object.fromEntries(
				Object.keys(r)
					.sort()
					.map((k) => [k, normalizeVal(r[k])])
			)
		)
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

interface Scenario {
	name: string;
	table: string;
	direction: 'y' | 'x';
	config: MarkConfig;
	select: Record<string, ExprNode>;
	orderConfig?: { seriesChannel: string | null; dimensionChannel: string };
	offset?: 'expand' | 'center';
}

async function runBothPaths(db: DB, s: Scenario) {
	const stackFn = s.direction === 'y' ? stackY : stackX;
	const opts = s.offset ? { offset: s.offset } : {};

	// --- SQL path ---
	const sqlCompiler = new TransformCompiler([stackFn(opts)], s.config);
	const sqlParts = buildQueryParts(s.select, s.orderConfig, true);
	const sqlQuery = assembleQuery({
		table: s.table,
		parts: sqlParts,
		transformCompiler: sqlCompiler
	});
	const sqlRows = canonical(await db.all(sqlQuery.toString()));

	// --- JS path: untransformed query, then JS stack on the result ---
	const jsCompiler = new TransformCompiler([], s.config);
	const baseParts = buildQueryParts(s.select, s.orderConfig, false);
	const baseQuery = assembleQuery({
		table: s.table,
		parts: baseParts,
		transformCompiler: jsCompiler
	});
	const baseRows = await db.all(baseQuery.toString());
	const jsResult = stackFn({ ...opts, engine: 'js' } as any).apply(
		rowsToAccessor(baseRows),
		s.config
	);
	const jsRows = accessorToRows(jsResult);

	return { sqlRows, jsRows, sqlText: sqlQuery.toString() };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const VERTICAL: MarkConfig = { markType: 'area', table: 'stacked', x: 'x', y: 'y2', fill: 'fill' };
const HORIZONTAL: MarkConfig = {
	markType: 'barx',
	table: 'stacked',
	x: 'x2',
	y: 'y',
	fill: 'fill'
};
const NAN_CONFIG: MarkConfig = {
	markType: 'area',
	table: 'stacked_nan',
	x: 'x',
	y: 'y2',
	fill: 'fill'
};

const scenarios: Scenario[] = [
	{
		name: 'stackY: vertical grouped series',
		table: 'stacked',
		direction: 'y',
		config: VERTICAL,
		select: { x: column('month'), y2: castReal(sum('value')), fill: column('series') },
		orderConfig: { seriesChannel: 'fill', dimensionChannel: 'x' }
	},
	{
		name: 'stackX: horizontal grouped series',
		table: 'stacked',
		direction: 'x',
		config: HORIZONTAL,
		select: { x2: castReal(sum('value')), y: column('month'), fill: column('series') },
		orderConfig: { seriesChannel: 'fill', dimensionChannel: 'y' }
	},
	{
		name: 'stackY: offset expand (0-1 fraction)',
		table: 'stacked',
		direction: 'y',
		config: VERTICAL,
		select: { x: column('month'), y2: castReal(sum('value')), fill: column('series') },
		orderConfig: { seriesChannel: 'fill', dimensionChannel: 'x' },
		offset: 'expand'
	},
	{
		name: 'stackY: offset center',
		table: 'stacked',
		direction: 'y',
		config: VERTICAL,
		select: { x: column('month'), y2: castReal(sum('value')), fill: column('series') },
		orderConfig: { seriesChannel: 'fill', dimensionChannel: 'x' },
		offset: 'center'
	},
	{
		name: 'stackY: NaN row gets NaN boundaries without poisoning later rows',
		table: 'stacked_nan',
		direction: 'y',
		config: NAN_CONFIG,
		select: { x: column('month'), y2: castReal(sum('value')), fill: column('series') },
		orderConfig: { seriesChannel: 'fill', dimensionChannel: 'x' }
	}
];

describe('stack SQL/JS parity (native DuckDB)', () => {
	let db: DB;

	beforeAll(async () => {
		db = openDB();
		await db.run(SEED_SQL);
	});

	afterAll(async () => {
		await db.close();
	});

	for (const s of scenarios) {
		it(s.name, async () => {
			const { sqlRows, jsRows } = await runBothPaths(db, s);
			expect(sqlRows).toEqual(jsRows);
		});
	}

	it('NaN row does not poison the running total for later rows in the band', async () => {
		const s = scenarios.find((x) => x.name.startsWith('stackY: NaN'))!;
		const { sqlRows } = await runBothPaths(db, s);

		// Feb/A is NaN (its own y0/y1 are NaN), but Feb/B (which sums after it)
		// must still see a clean running total unaffected by the NaN.
		const febB = sqlRows.find((r) => r.x === 'Feb' && r.fill === 'B')!;
		expect(febB.y0).toBe(0);
		expect(febB.y1).toBe(15);

		const febA = sqlRows.find((r) => r.x === 'Feb' && r.fill === 'A')!;
		expect(febA.y0).toBe('NaN');
		expect(febA.y1).toBe('NaN');
	});

	it('filter is applied inside the stack CTE (crossfilter re-stacks the subset)', async () => {
		const s = scenarios[0];
		const stackFn = stackY;
		const compiler = new TransformCompiler([stackFn()], s.config);
		const parts = buildQueryParts(s.select, s.orderConfig, true);
		const query = assembleQuery({
			table: s.table,
			parts,
			filter: [eq(column('series'), literal('North'))],
			transformCompiler: compiler
		});
		const sqlText = query.toString();
		const predicate = '"series" = \'North\'';
		expect(sqlText.split(predicate).length - 1).toBe(1);
		expect(sqlText.indexOf(predicate)).toBeLessThan(sqlText.indexOf('"__stack_base"'));
	});
});
