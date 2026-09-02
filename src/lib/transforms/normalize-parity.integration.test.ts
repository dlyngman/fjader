/**
 * Integration test: SQL normalize and JS normalize must produce identical
 * percentages, and SQL-normalize-then-stack must commute with the legacy
 * stack-then-JS-normalize order.
 *
 * Runs the real query assembly path (buildQueryParts + assembleQuery +
 * TransformCompiler) against native DuckDB. Covers the shapes the mark
 * layer actually produces: vertical grouped bars (y2 alias), horizontal
 * bars (x2 alias, axis swap), a binned-dot shape (x=bin, y=count,
 * fill=species), and crossfilter re-normalization.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { Query, column, sum, count, eq, literal, type ExprNode } from '@uwdata/mosaic-sql';
import { normalize, stackY, TransformCompiler } from './index';
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
// Fixture: same shape as the topN parity fixture (category/region/revenue),
// plus a species/bin fixture for the binned-dot shape.
// ---------------------------------------------------------------------------

const SEED_SQL = `
CREATE TABLE sales AS
SELECT * FROM (VALUES
	('Electronics', 'North', 10), ('Electronics', 'South', 400),
	('Clothing', 'North', 10),    ('Clothing', 'South', 250),
	('Food', 'North', 5),         ('Food', 'South', 200)
) AS t(category, region, revenue);

CREATE TABLE dots AS
SELECT * FROM (VALUES
	(0, 'a'), (0, 'a'), (0, 'b'),
	(5, 'a'), (5, 'b'), (5, 'b'), (5, 'b')
) AS t(bin, species);
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
	// Round to 3 decimals: SQL path stays DOUBLE, JS path passes through
	// Float32Array (~7 significant digits), so exact equality on percentages
	// (0-100 range) needs slack below float32 precision.
	if (typeof v === 'number') return Math.round(v * 1e3) / 1e3;
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
	config: MarkConfig;
	select: Record<string, ExprNode>;
	orderConfig?: { seriesChannel: string | null; dimensionChannel: string };
	filter?: ExprNode[];
}

async function runBothPaths(db: DB, s: Scenario) {
	const filter = s.filter ?? [];

	// --- SQL path: real assembly with normalize as a SQL transform ---
	const sqlCompiler = new TransformCompiler([normalize()], s.config);
	const sqlParts = buildQueryParts(s.select, s.orderConfig, true);
	const sqlQuery = assembleQuery({
		table: s.table,
		parts: sqlParts,
		filter,
		transformCompiler: sqlCompiler
	});
	const sqlRows = canonical(await db.all(sqlQuery.toString()));

	// --- JS path: untransformed query, then JS normalize on the result ---
	const jsCompiler = new TransformCompiler([normalize({ engine: 'js' })], s.config);
	const baseParts = buildQueryParts(s.select, s.orderConfig, false);
	const baseQuery = assembleQuery({
		table: s.table,
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
const DOTS: MarkConfig = { markType: 'dot', table: 'dots', x: 'x', y: 'y', fill: 'fill' };

const scenarios: Scenario[] = [
	{
		name: 'vertical grouped bars (y2 alias) — percentages sum to 100 per band',
		table: 'sales',
		config: GROUPED,
		select: { x: column('category'), y2: sum('revenue'), fill: column('region') },
		orderConfig: { seriesChannel: 'fill', dimensionChannel: 'x' }
	},
	{
		name: 'horizontal bars (x2 alias, axis swap)',
		table: 'sales',
		config: HORIZONTAL,
		select: { x2: sum('revenue'), y: column('category') }
	},
	{
		name: 'binned-dot shape (x=bin, y=count, fill=species)',
		table: 'dots',
		config: DOTS,
		select: { x: column('bin'), y: count(), fill: column('species') },
		orderConfig: { seriesChannel: 'fill', dimensionChannel: 'x' }
	},
	{
		name: 'crossfilter re-normalizes within the filtered subset',
		table: 'sales',
		config: VERTICAL,
		select: { x: column('category'), y2: sum('revenue') },
		filter: [eq(column('region'), literal('North'))]
	}
];

describe('normalize SQL/JS parity (native DuckDB)', () => {
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

			// Percentages within each band sum to 100 (or 0 when the whole band is empty).
			const valueCol = s.config.markType === 'barx' ? s.config.x! : s.config.y!;
			const bandCol = s.config.markType === 'barx' ? s.config.y! : s.config.x!;
			const totals = new Map<unknown, number>();
			for (const r of sqlRows) {
				totals.set(bandCol && r[bandCol], (totals.get(r[bandCol]) || 0) + Number(r[valueCol]));
			}
			for (const total of totals.values()) {
				expect(total).toBeCloseTo(100, 5);
			}
		});
	}

	it('commutes with stack: SQL-normalize-then-stack equals stack-then-legacy-JS-normalize', async () => {
		const config: MarkConfig = { markType: 'area', table: 'sales', x: 'x', y: 'y2', fill: 'fill' };
		const select = { x: column('category'), y2: sum('revenue'), fill: column('region') };
		const orderConfig = { seriesChannel: 'fill', dimensionChannel: 'x' };

		// New order: SQL normalize (in the query) -> JS stackY on the result.
		const newCompiler = new TransformCompiler([normalize()], config);
		const newParts = buildQueryParts(select, orderConfig, true);
		const newQuery = assembleQuery({
			table: 'sales',
			parts: newParts,
			transformCompiler: newCompiler
		});
		const normalizedRows = await db.all(newQuery.toString());
		const stacked = stackY().apply(rowsToAccessor(normalizedRows), config);

		// Legacy order: JS stackY first, then legacy JS normalize (y0/y1-aware).
		const oldCompiler = new TransformCompiler([], config);
		const oldParts = buildQueryParts(select, orderConfig, false);
		const oldQuery = assembleQuery({ table: 'sales', parts: oldParts, transformCompiler: oldCompiler });
		const rawRows = await db.all(oldQuery.toString());
		const preStacked = stackY().apply(rowsToAccessor(rawRows), config);
		const legacyNormalized = normalize({ engine: 'js' }).apply(preStacked, config);

		const newRows = accessorToRows(stacked);
		const oldRows = accessorToRows(legacyNormalized);
		expect(newRows).toEqual(oldRows);
	});
});
