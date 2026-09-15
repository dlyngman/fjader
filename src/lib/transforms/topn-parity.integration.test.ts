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
import { topN, stackY, TransformCompiler, TOPN_RANK_COLUMN } from './index';
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

	it('publishes its ranking as a column that survives the stack wrapper', async () => {
		// The shape a BAR MARK actually produces, which is the whole point of this
		// test: BarMarkY prepends stackY to the user's transforms, so topN's query
		// is immediately wrapped in `Query.from({ __stack_base: ... })` whose outer
		// SELECT is a window PARTITIONed by the band column.
		//
		// The previous version of this test built parts by hand with no stack, saw
		// its ORDER BY land outermost, and concluded topN returned ranked rows. It
		// does not: DuckDB re-partitions for the window and the row order that
		// reaches the axis is keyed by dim id. Asserting on a query shape the app
		// never emits is what let that ship (§34.4/§34.5).
		const s = scenarios.find((x) => x.name.startsWith('vertical bars'))!;
		const compiler = new TransformCompiler([topN(s.n), stackY()], s.config);
		const parts = buildQueryParts(s.select, s.orderConfig, true);
		const text = assembleQuery({
			table: 'sales',
			parts,
			filter: [],
			transformCompiler: compiler
		}).toString();

		// The stack wrapper is present, so this is the real shape...
		expect(text).toContain('__stack_base');
		// ...and the rank survives it as a column, carried by stackSQL's
		// passthroughSelect without stackSQL knowing it exists.
		expect(text).toContain(TOPN_RANK_COLUMN);

		const rows = await db.all(text);
		const byRank = rows
			.slice()
			.sort((a, b) => Number(a[TOPN_RANK_COLUMN]) - Number(b[TOPN_RANK_COLUMN]));
		expect(byRank.map((r) => r.x)).toEqual(['Electronics', 'Clothing', 'Food', 'Music', 'Books']);

		// And nothing is ordering the result: the ONLY ORDER BY in the whole query
		// is the one inside ROW_NUMBER()'s OVER clause, which defines the ranking
		// rather than the row order. An outer ORDER BY here would mean someone had
		// reintroduced the mechanism this replaced — it cannot survive the window
		// above, so it would be a claim the query does not keep.
		expect(text.match(/ORDER BY/g)).toHaveLength(1);
		expect(text).toContain('ROW_NUMBER() OVER (ORDER BY');
	});

	it('hides the rank from tooltips by using the __dplot_ prefix', () => {
		// #writeTooltipTable filters exactly this prefix. A rank column named
		// anything else would render as a user-visible tooltip row.
		expect(TOPN_RANK_COLUMN.startsWith('__dplot_')).toBe(true);
	});

	it('preserves ORDER BY for connected/series marks on the outer query', async () => {
		const s = scenarios.find((x) => x.name.startsWith('grouped bars'))!;
		const { sqlText } = await runBothPaths(db, s);
		expect(sqlText.trimEnd()).toMatch(/ORDER BY "fill", "x"$/);
	});
});

// ---------------------------------------------------------------------------
// The dense LEFT JOIN: every category keeps a row (§44)
// ---------------------------------------------------------------------------
//
// A category that drops out of the top N has no row, so there is nothing to
// animate out — it vanishes on the frame the reorder lands. Joining from the
// dim keeps it, at zero. These run against real DuckDB because the question is
// SQL semantics (which rows come back, with what values), which is the half of
// the boundary the npm driver and duckdb-wasm agree on — unlike types and
// batching, where §29.10b applies.

describe('topN dense join', () => {
	let db: DB;
	const DIM = '__dplot_dim_category_test';

	beforeAll(async () => {
		db = openDB();
		await db.run(SEED_SQL);
		// The dim as categorical-identity builds it: ids assigned by value order,
		// dense from 0, never renumbered.
		await db.run(
			`CREATE TABLE "${DIM}" AS
			 SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id
			 FROM (SELECT DISTINCT category AS value FROM sales)`
		);
		// The band channel carries the dim id, as the identity view emits it.
		await db.run(
			`CREATE TABLE sales_v AS
			 SELECT s.*, COALESCE(d.id, -1) AS category_idx
			 FROM sales s LEFT JOIN "${DIM}" d ON s.category = d.value`
		);
	});
	afterAll(async () => await db.close());

	const base = () =>
		Query.from('sales_v')
			.select({ x: column('category_idx'), y2: sum(column('revenue')) })
			.groupby(column('category_idx'));

	const cfg = { markType: 'barY', table: 'sales_v', x: 'x', y: 'y2' } as MarkConfig;

	async function run(dense: boolean, n: number) {
		const t = topN(n, { by: 'y2' });
		const q = t.apply(base(), {
			...cfg,
			...(dense ? { dimTableByChannel: { x: DIM } } : {})
		});
		return db.all(q.toString());
	}

	it('returns one row per category in the dim, not per displayed category', async () => {
		const [dimRows] = await db.all(`SELECT COUNT(*)::INT AS n FROM "${DIM}"`);
		const total = dimRows.n as number;
		expect(total).toBeGreaterThan(3);

		expect((await run(false, 3)).length).toBe(3);
		expect((await run(true, 3)).length).toBe(total);
	});

	it('gives an excluded category a zero measure and no rank', async () => {
		const rows = await run(true, 3);
		// NaN, not NULL: the rank is coalesced so the column reaches JS with
		// nullCount 0, which is what DataAccessor's zero-copy path requires.
		const isRanked = (r: Record<string, unknown>) => Number.isFinite(Number(r[TOPN_RANK_COLUMN]));
		const ranked = rows.filter(isRanked);
		const excluded = rows.filter((r) => !isRanked(r));

		expect(ranked.length).toBe(3);
		expect(excluded.length).toBe(rows.length - 3);

		// The whole point: an excluded category is present, at zero, so a bar can
		// shrink to nothing rather than disappear.
		for (const r of excluded) expect(Number(r.y2)).toBe(0);
		// And it still carries its own id, so the buffer slot it occupies is its
		// own rather than someone else's.
		expect(new Set(rows.map((r) => r.x)).size).toBe(rows.length);
	});

	it('leaves the displayed rows byte-identical to the sparse query', async () => {
		// The join must not disturb what topN already produced — it only adds.
		const sparse = await run(false, 3);
		const dense = (await run(true, 3)).filter((r) => Number.isFinite(Number(r[TOPN_RANK_COLUMN])));

		const key = (r: Record<string, unknown>) => `${r.x}:${Number(r.y2)}:${r[TOPN_RANK_COLUMN]}`;
		expect(new Set(dense.map(key))).toEqual(new Set(sparse.map(key)));
	});

	it('covers the whole id space, densely, so row order can align with id', async () => {
		// The alignment §44 turns on: with ORDER BY d.id the result is the
		// id-indexed buffer. This asserts the ids are 0..n-1 with no gaps, which
		// is what makes that indexing meaningful at all.
		const rows = await run(true, 3);
		const ids = rows.map((r) => Number(r.x)).sort((a, b) => a - b);
		expect(ids).toEqual(ids.map((_, i) => i));
	});

	it('is off unless a dim is supplied, so every existing mark is unchanged', async () => {
		const rows = await run(false, 3);
		expect(rows.length).toBe(3);
		for (const r of rows) expect(Number.isFinite(Number(r[TOPN_RANK_COLUMN]))).toBe(true);
	});
});
