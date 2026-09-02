/**
 * Integration test: SQL topN and JS topN must produce identical rows.
 *
 * Runs the real query assembly path (buildQueryParts + assembleQuery +
 * TransformCompiler) against native DuckDB, and compares against the JS
 * topN applied to the untransformed query result. Covers the shapes the
 * mark layer actually produces: vertical bars (y2 alias), horizontal bars
 * (x2 alias, axis swap), grouped/series bars, and crossfilter re-ranking.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { Query, column, sum, eq, literal, type ExprNode } from '@uwdata/mosaic-sql';
import { topN, TransformCompiler } from './index';
import { buildQueryParts, assembleQuery } from '$lib/components/marks/lifecycle/query-builder';
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
// Fixture: same data as /test/top-n route. Region skew means the top 5
// under a region filter differs from the unfiltered top 5.
// ---------------------------------------------------------------------------

const SEED_SQL = `
CREATE TABLE sales AS
SELECT * FROM (VALUES
	('Electronics', 'North', 10),  ('Electronics', 'South', 400), ('Electronics', 'West', 90),
	('Clothing', 'North', 10),     ('Clothing', 'South', 250),    ('Clothing', 'West', 40),
	('Food', 'North', 5),          ('Food', 'South', 200),        ('Food', 'West', 45),
	('Books', 'North', 5),         ('Books', 'South', 170),       ('Books', 'West', 25),
	('Toys', 'North', 5),          ('Toys', 'South', 130),        ('Toys', 'West', 15),
	('Sports', 'North', 130),      ('Sports', 'South', 5),        ('Sports', 'West', 5),
	('Garden', 'North', 180),      ('Garden', 'South', 5),        ('Garden', 'West', 5),
	('Health', 'North', 150),      ('Health', 'South', 5),        ('Health', 'West', 5),
	('Auto', 'North', 140),        ('Auto', 'South', 5),          ('Auto', 'West', 5),
	('Music', 'North', 200),       ('Music', 'South', 5),         ('Music', 'West', 5)
) AS t(category, region, revenue)
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rows → column-oriented accessor (mirrors ArrowDataAccessor shape). */
function rowsToAccessor(rows: Record<string, unknown>[]): DataAccessor {
	const columns: Record<string, unknown[]> = {};
	for (const row of rows) {
		for (const [k, v] of Object.entries(row)) {
			(columns[k] ??= []).push(v);
		}
	}
	return new ColumnDataAccessor(columns, rows.length);
}

/** Accessor → canonical sorted row list for order-independent comparison. */
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

/** Native DuckDB returns BigInt for integer SUMs; JS path holds numbers. */
function normalize(v: unknown): unknown {
	return typeof v === 'bigint' ? Number(v) : v;
}

function canonical(rows: Record<string, unknown>[]): Record<string, unknown>[] {
	return rows
		.map((r) =>
			Object.fromEntries(
				Object.keys(r)
					.sort()
					.map((k) => [k, normalize(r[k])])
			)
		)
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

interface Scenario {
	name: string;
	config: MarkConfig;
	select: Record<string, ExprNode>;
	orderConfig?: { seriesChannel: string | null; dimensionChannel: string };
	n: number;
	filter?: ExprNode[];
	expectedBand: string[];
}

async function runBothPaths(db: DB, s: Scenario) {
	const filter = s.filter ?? [];

	// --- SQL path: real assembly with topN as a SQL transform ---
	const sqlCompiler = new TransformCompiler([topN(s.n)], s.config);
	const sqlParts = buildQueryParts(s.select, s.orderConfig, true);
	const sqlQuery = assembleQuery({
		table: 'sales',
		parts: sqlParts,
		filter,
		transformCompiler: sqlCompiler
	});
	const sqlRows = canonical(await db.all(sqlQuery.toString()));

	// --- JS path: untransformed query, then JS topN on the result ---
	const jsCompiler = new TransformCompiler([topN(s.n, { engine: 'js' })], s.config);
	const baseParts = buildQueryParts(s.select, s.orderConfig, false);
	const baseQuery = assembleQuery({
		table: 'sales',
		parts: baseParts,
		filter,
		transformCompiler: jsCompiler
	});
	const baseRows = await db.all(baseQuery.toString());
	const jsRows = accessorToRows(jsCompiler.applyToData(rowsToAccessor(baseRows), s.config));

	return { sqlRows, jsRows, sqlText: sqlQuery.toString() };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const VERTICAL: MarkConfig = { markType: 'bary', table: 'sales', x: 'x', y: 'y2' };
const HORIZONTAL: MarkConfig = { markType: 'barx', table: 'sales', x: 'x2', y: 'y' };
const GROUPED: MarkConfig = { markType: 'bary', table: 'sales', x: 'x', y: 'y2', fill: 'fill' };

const scenarios: Scenario[] = [
	{
		name: 'vertical bars (y2 alias)',
		config: VERTICAL,
		select: { x: column('category'), y2: sum('revenue') },
		n: 5,
		expectedBand: ['Electronics', 'Clothing', 'Food', 'Music', 'Books']
	},
	{
		name: 'horizontal bars (x2 alias, axis swap)',
		config: HORIZONTAL,
		select: { x2: sum('revenue'), y: column('category') },
		n: 3,
		expectedBand: ['Electronics', 'Clothing', 'Food']
	},
	{
		name: 'grouped bars rank by category total, keep all series rows',
		config: GROUPED,
		select: { x: column('category'), y2: sum('revenue'), fill: column('region') },
		orderConfig: { seriesChannel: 'fill', dimensionChannel: 'x' },
		n: 5,
		expectedBand: ['Electronics', 'Clothing', 'Food', 'Music', 'Books']
	},
	{
		name: 'crossfilter re-ranks within the filtered subset',
		config: VERTICAL,
		select: { x: column('category'), y2: sum('revenue') },
		n: 5,
		filter: [eq(column('region'), literal('North'))],
		expectedBand: ['Music', 'Garden', 'Health', 'Auto', 'Sports']
	},
	{
		name: 'grouped + crossfilter',
		config: GROUPED,
		select: { x: column('category'), y2: sum('revenue'), fill: column('region') },
		orderConfig: { seriesChannel: 'fill', dimensionChannel: 'x' },
		n: 5,
		filter: [eq(column('region'), literal('North'))],
		expectedBand: ['Music', 'Garden', 'Health', 'Auto', 'Sports']
	}
];

describe('topN SQL/JS parity (native DuckDB)', () => {
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

			const bandCol = s.config.markType === 'barx' ? s.config.y! : s.config.x!;
			const bands = [...new Set(sqlRows.map((r) => r[bandCol]))].sort();
			expect(bands).toEqual([...s.expectedBand].sort());
		});
	}

	it('filter is applied inside the topN CTE, not on its output', async () => {
		const s = scenarios.find((x) => x.name.startsWith('crossfilter'))!;
		const { sqlText } = await runBothPaths(db, s);

		// The region predicate must appear exactly once, inside the base scan
		// subquery (whose body prints before its `AS "__topn_base"` alias),
		// never as a WHERE on the ranked output.
		const predicate = '"region" = \'North\'';
		expect(sqlText.split(predicate).length - 1).toBe(1);
		expect(sqlText.indexOf(predicate)).toBeLessThan(sqlText.indexOf('"__topn_base"'));
	});

	it('preserves ORDER BY for connected/series marks on the outer query', async () => {
		const s = scenarios.find((x) => x.name.startsWith('grouped bars'))!;
		const { sqlText } = await runBothPaths(db, s);
		expect(sqlText.trimEnd()).toMatch(/ORDER BY "fill", "x"$/);
	});
});
