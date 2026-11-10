/**
 * Integration test: the SQL topN against native DuckDB.
 *
 * Runs the real query assembly path (buildQueryParts + assembleQuery +
 * TransformCompiler), and compares against the same result computed as a plain
 * GROUP BY over the untransformed query. Covers the shapes the
 * mark layer actually produces: vertical bars (y2 alias), horizontal bars
 * (x2 alias, axis swap), grouped/series bars, and crossfilter re-ranking.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { Query, column, sum, eq, literal, sql as sqlTag, type ExprNode } from '@uwdata/mosaic-sql';
import {
	topN,
	stackY,
	TransformCompiler,
	RANK_COLUMN,
	withDenseCategories,
	OTHER_IDS_COLUMN,
	OTHER_VALUES_COLUMN,
	withoutOtherMembers
} from './index';
import {
	buildQueryParts,
	assembleQuery,
	type QueryParts
} from '$lib/components/marks/lifecycle/query-builder';
import { ColumnDataAccessor, type DataAccessor } from '$lib/data/DataAccessor';
import { extractIdsRankedFromData } from '$lib/components/marks/lifecycle/domain-computation';
import type { MarkConfig, SqlTransform } from '$lib/types';
import type { SelectQuery } from '@uwdata/mosaic-sql';

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

/** Native DuckDB returns BigInt for integer SUMs. */
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

/**
 * The SQL topN, and what it should return computed a second, obvious way.
 *
 * The reference is the untransformed query restricted to the categories a plain
 * GROUP BY ... ORDER BY total DESC, band LIMIT n picks — in DuckDB, not in a
 * second implementation of topN. The JS topN used to be the reference, and it
 * had bugs of its own.
 */
async function runSQL(db: DB, s: Scenario) {
	const filter = s.filter ?? [];
	const band = s.config.markType === 'barx' ? 'y' : 'x';
	const by = s.config.markType === 'barx' ? 'x2' : 'y2';

	const compiler = new TransformCompiler([topN(s.n)], s.config);
	const parts = buildQueryParts(s.select, s.orderConfig, true);
	const sqlQuery = assembleQuery({ table: 'sales', parts, filter, transformCompiler: compiler });
	const sqlRows = canonical(
		(await db.all(sqlQuery.toString())).map(({ [RANK_COLUMN]: _rank, ...rest }) => rest)
	);

	const base = assembleQuery({
		table: 'sales',
		parts: buildQueryParts(s.select, s.orderConfig, false),
		filter,
		transformCompiler: new TransformCompiler([], s.config)
	}).toString();
	const expectedRows = canonical(
		await db.all(
			`SELECT * FROM (${base}) WHERE "${band}" IN (
			   SELECT "${band}" FROM (${base}) GROUP BY "${band}"
			   ORDER BY SUM("${by}") DESC, "${band}" LIMIT ${s.n})`
		)
	);

	return { sqlRows, expectedRows, sqlText: sqlQuery.toString() };
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

describe('topN against a DuckDB reference', () => {
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
			const { sqlRows, expectedRows } = await runSQL(db, s);

			expect(sqlRows).toEqual(expectedRows);

			const bandCol = s.config.markType === 'barx' ? s.config.y! : s.config.x!;
			const bands = [...new Set(sqlRows.map((r) => r[bandCol]))].sort();
			expect(bands).toEqual([...s.expectedBand].sort());
		});
	}

	it('filter is applied inside the topN CTE, not on its output', async () => {
		const s = scenarios.find((x) => x.name.startsWith('crossfilter'))!;
		const { sqlText } = await runSQL(db, s);

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
		// never emits is what let that ship.
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
		expect(text).toContain(RANK_COLUMN);

		const rows = await db.all(text);
		const byRank = rows.slice().sort((a, b) => Number(a[RANK_COLUMN]) - Number(b[RANK_COLUMN]));
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
		expect(RANK_COLUMN.startsWith('__dplot_')).toBe(true);
	});

	it('preserves ORDER BY for connected/series marks on the outer query', async () => {
		const s = scenarios.find((x) => x.name.startsWith('grouped bars'))!;
		const { sqlText } = await runSQL(db, s);
		expect(sqlText.trimEnd()).toMatch(/ORDER BY "fill", "x"$/);
	});
});

// ---------------------------------------------------------------------------
// The dense LEFT JOIN: every category keeps a row
// ---------------------------------------------------------------------------
//
// A category that drops out of the top N has no row, so there is nothing to
// animate out — it vanishes on the frame the reorder lands. Joining from the
// dim keeps it, at zero. These run against real DuckDB because the question is
// SQL semantics (which rows come back, with what values), which is the half of
// the boundary the npm driver and duckdb-wasm agree on. They do NOT agree on
// types or on Arrow batching, so nothing here may assert on either.

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

	const cfg = {
		markType: 'barY',
		table: 'sales_v',
		x: 'x',
		y: 'y2',
		groupKeys: ['x']
	} as MarkConfig;

	/**
	 * Composed the way the lifecycle composes it: topN drops categories, then
	 * `dense` puts a zero row back for each one. `dense` refuses itself when no
	 * dim is supplied, which is what the `isDense = false` case exercises.
	 */
	async function run(isDense: boolean, n: number) {
		const markConfig = {
			...cfg,
			...(isDense ? { identity: { x: { dim: DIM, size: 100, positional: true } } } : {})
		} as MarkConfig;
		const transforms = withDenseCategories([topN(n, { by: 'y2' })]);
		let q = base() as SelectQuery;
		for (const t of transforms) q = (t as SqlTransform).apply(q, markConfig);
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
		const isRanked = (r: Record<string, unknown>) => Number.isFinite(Number(r[RANK_COLUMN]));
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
		const dense = (await run(true, 3)).filter((r) => Number.isFinite(Number(r[RANK_COLUMN])));

		const key = (r: Record<string, unknown>) => `${r.x}:${Number(r.y2)}:${r[RANK_COLUMN]}`;
		expect(new Set(dense.map(key))).toEqual(new Set(sparse.map(key)));
	});

	it('covers the whole id space, densely, so row order can align with id', async () => {
		// The alignment this exists for: ordered by id, the result IS the
		// id-indexed buffer. This asserts the ids are 0..n-1 with no gaps, which
		// is what makes that indexing meaningful at all.
		const rows = await run(true, 3);
		const ids = rows.map((r) => Number(r.x)).sort((a, b) => a - b);
		expect(ids).toEqual(ids.map((_, i) => i));
	});

	it('is off unless a dim is supplied, so every existing mark is unchanged', async () => {
		const rows = await run(false, 3);
		expect(rows.length).toBe(3);
		for (const r of rows) expect(Number.isFinite(Number(r[RANK_COLUMN]))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Row order, on the OUTERMOST query
// ---------------------------------------------------------------------------
//
// A dense result is only usable as a category-indexed array while row i is the
// same category on every update, and nothing guarantees that by itself — hash
// aggregation returns groups in whatever order it likes and need not pick the
// same one twice.
//
// The ordering therefore has to be applied outside every wrapping transform. An
// ORDER BY inside one looks right, verifies right against the database on its
// own, and is thrown away one level up: a bar mark stacks by default, and the
// stack's outer query is a window PARTITIONed by the same column, so the
// optimiser re-partitions and the surviving order is the window operator's.
// That failure took four attempts to find once already, which is why it is
// pinned here against real DuckDB rather than asserted on the SQL string.

describe('dense pads only the categories its own table holds', () => {
	let db: DB;
	const DIM = '__dplot_dim_cat_present';
	const PRESENT = '__dplot_dim_cat_present_t_mine';

	beforeAll(async () => {
		db = openDB();
		// A dim shared by two tables: ids 0..3 are this table's, 4 only another
		// table's, 5 an Other bucket (label set).
		await db.run(
			`CREATE TABLE "${DIM}" AS SELECT * FROM (VALUES
				('a', NULL, 0), ('b', NULL, 1), ('c', NULL, 2), ('d', NULL, 3),
				('elsewhere', NULL, 4), (NULL, 'Other', 5)) t(value, label, id)`
		);
		await db.run(`CREATE TABLE "${PRESENT}" AS SELECT * FROM (VALUES (0), (1), (2), (3)) t(id)`);
		await db.run(
			`CREATE TABLE mine AS SELECT * FROM (VALUES (0, 10), (1, 20), (2, 30), (3, 40)) t(cat_idx, v)`
		);
	});
	afterAll(async () => await db.close());

	async function run(present: boolean, n = 2) {
		const config = {
			markType: 'barY',
			table: 'mine',
			x: 'x',
			y: 'y2',
			groupKeys: ['x'],
			identity: {
				x: {
					dim: DIM,
					size: 6,
					positional: true,
					otherId: 5,
					...(present ? { present: PRESENT } : {})
				}
			}
		} as MarkConfig;
		let q = Query.from('mine')
			.select({ x: column('cat_idx'), y2: sum(column('v')) })
			.groupby(column('cat_idx')) as SelectQuery;
		for (const t of withDenseCategories([topN(n, { by: 'y2', includeOthers: true })]))
			q = (t as SqlTransform).apply(q, config);
		return db.all(String(q));
	}

	it('pads no row for a category only another table holds', async () => {
		const xs = (await run(true)).map((r) => Number(r.x));
		expect(xs).not.toContain(4);
		// Its own four, and the Other row.
		expect(new Set(xs)).toEqual(new Set([0, 1, 2, 3, 5]));
	});

	it('padded from the whole dim when the table is not recorded, as before', async () => {
		const xs = (await run(false)).map((r) => Number(r.x));
		expect(xs).toContain(4);
	});

	it('keeps the Other row and its value', async () => {
		const rows = await run(true);
		const other = rows.find((r) => Number(r.x) === 5)!;
		// Top 2 are d (40) and c (30); Other is a + b.
		expect(Number(other.y2)).toBeCloseTo(30, 5);
	});
});

describe('dense row order', () => {
	let db: DB;
	const DIM = '__dplot_dim_order_test';

	beforeAll(async () => {
		db = openDB();
		await db.run(SEED_SQL);
		await db.run(
			`CREATE TABLE "${DIM}" AS
			 SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id
			 FROM (SELECT DISTINCT category AS value FROM sales)`
		);
		await db.run(
			`CREATE TABLE sales_o AS
			 SELECT s.*, COALESCE(d.id, -1) AS category_idx
			 FROM sales s LEFT JOIN "${DIM}" d ON s.category = d.value`
		);
	});
	afterAll(async () => await db.close());

	/**
	 * The shape a bar mark emits: dense topN, then the implicit stack.
	 *
	 * No `fill`. A series channel routes topN down its grouped branch, which
	 * ranks inside a subquery and has no dense join — so a GROUPED topN still
	 * returns only its survivors, and a category leaving one still vanishes.
	 * That is a real remaining limit and not a quirk of this fixture.
	 */
	function build(isDense: boolean) {
		const parts = buildQueryParts(
			{ x: column('category_idx'), y2: sum(column('revenue')) },
			null,
			true
		);
		const transforms = withDenseCategories([topN(3, { by: 'y2' }), stackY()], isDense);
		const compiler = new TransformCompiler(transforms, {
			markType: 'barY',
			table: 'sales_o',
			x: 'x',
			y: 'y2',
			identity: { x: { dim: DIM, size: 100, positional: true } }
		} as MarkConfig);
		return assembleQuery({ table: 'sales_o', parts, filter: [], transformCompiler: compiler });
	}

	it('comes back in id order once the outer query is ordered', async () => {
		const rows = await db.all(build(true)!.toString());
		const ids = rows.map((r) => Number(r.x));
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		// Dense AND in order is what makes row index usable as a category index.
		expect(ids).toEqual(ids.map((_, i) => i));
	});

	it('is the outer query that carries it, not the transform', async () => {
		// The control, so the previous test proves something: with dense opted
		// out there is no alignment, and nothing orders the outermost query. The
		// dense join does not order its own result either — an ORDER BY there
		// would be discarded by the stack wrapping it, and would read as a
		// guarantee it is not.
		const outerTail = (sql: string) => sql.slice(sql.lastIndexOf(') AS "__stack_base"'));
		expect(outerTail(build(false)!.toString())).not.toContain('ORDER BY');
		const aligned = build(true)!.toString();
		expect(outerTail(aligned)).toContain('ORDER BY "x"');
		expect(aligned).not.toMatch(/ORDER BY\s+d\."id"/);
	});

	it('orders a query over a pre-aggregated table the same way', async () => {
		// The shape the preagg path assembles: its own parts over a cube, group
		// keys taken from the cube's dimension columns, the mark's compiler. The
		// alignment comes from those parts, so a crossfilter served from a cube
		// hands the GPU rows in the same order as one served from the base table.
		await db.run(
			`CREATE OR REPLACE TABLE sales_cube AS
			 SELECT category_idx::REAL AS x, region, SUM(revenue) AS y2
			 FROM sales_o GROUP BY ALL`
		);
		const parts: QueryParts = {
			selectDef: { x: column('x'), y2: sqlTag`CAST(SUM("y2") AS REAL)` },
			nonAggregateGroupBy: [column('x')],
			hasAggregates: true,
			groupKeys: ['x'],
			hasWindowAggregates: false,
			hasSQLTransforms: true,
			orderChannels: null,
			aliasMap: new Map([
				['x', 'x'],
				['y2', 'y2']
			]),
			passthroughChannels: new Map()
		};
		const compiler = new TransformCompiler(withDenseCategories([stackY()]), {
			markType: 'barY',
			table: 'sales_cube',
			x: 'x',
			y: 'y2',
			identity: { x: { dim: DIM, size: 100, positional: true } }
		} as MarkConfig);
		// Filter one category out entirely, so padding is what keeps its row.
		const q = assembleQuery({
			table: 'sales_cube',
			parts,
			filter: [sqlTag`x <> 0`],
			transformCompiler: compiler
		});
		const rows = await db.all(q.toString());
		const ids = rows.map((r) => Number(r.x));
		const dimSize = Number((await db.all(`SELECT COUNT(*) AS n FROM "${DIM}"`))[0].n);
		expect(ids).toEqual(Array.from({ length: dimSize }, (_, i) => i));
		// Reached independently of the padding under test: in the cube itself,
		// category 0 has revenue, so a zero here can only be the padded row.
		const [cube] = await db.all(`SELECT SUM(y2) AS total FROM sales_cube WHERE x = 0`);
		expect(Number(cube.total)).toBeGreaterThan(0);
		expect(Number(rows[0].y2)).toBe(0);
		expect(q.toString().slice(q.toString().lastIndexOf(') AS "__stack_base"'))).toContain(
			'ORDER BY "x"'
		);
	});
});

// ---------------------------------------------------------------------------
// dense() on its own, with no ranking transform in front of it
// ---------------------------------------------------------------------------
//
// The shape every ordinary bar chart produces, and the one every test above
// missed: they all composed topN with dense, so the rank column was always
// present and the code that projects it was never exercised without one. It
// asked the join for a column that did not exist, which surfaces as a binder
// error naming a values list rather than a mark.

describe('dense without topN', () => {
	let db: DB;
	const DIM = '__dplot_dim_plain_test';

	beforeAll(async () => {
		db = openDB();
		await db.run(SEED_SQL);
		await db.run(
			`CREATE TABLE "${DIM}" AS
			 SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id
			 FROM (SELECT DISTINCT category AS value FROM sales)`
		);
		await db.run(
			`CREATE TABLE sales_p AS
			 SELECT s.*, COALESCE(d.id, -1) AS category_idx
			 FROM sales s LEFT JOIN "${DIM}" d ON s.category = d.value`
		);
	});
	afterAll(async () => await db.close());

	const markConfig = {
		markType: 'barY',
		table: 'sales_p',
		x: 'x',
		y: 'y2',
		groupKeys: ['x'],
		identity: { x: { dim: DIM, size: 100, positional: true } }
	} as MarkConfig;

	/** A plain aggregated bar chart, filtered so a category has no rows at all. */
	function build(where?: string) {
		let q = Query.from('sales_p')
			.select({ x: column('category_idx'), y2: sum(column('revenue')) })
			.groupby(column('category_idx'));
		if (where) q = q.where(sqlTag`${column('region')} = ${literal(where)}`);
		const transforms = withDenseCategories([]);
		let out = q as SelectQuery;
		for (const t of transforms) out = (t as SqlTransform).apply(out, markConfig);
		return out;
	}

	it('runs at all, which is what the rank projection broke', async () => {
		const rows = await db.all(build().toString());
		expect(rows.length).toBeGreaterThan(0);
	});

	it('keeps the row set the same size when a filter empties a category', async () => {
		// The point of densifying by default. Without it, a category with no rows
		// vanishes from the GROUP BY, every row after it shifts up, and nothing
		// downstream can tell that from a category that never existed.
		const all = await db.all(build().toString());
		const filtered = await db.all(build('North').toString());

		expect(filtered.length).toBe(all.length);
		expect(filtered.map((r) => Number(r.x))).toEqual(all.map((r) => Number(r.x)));
	});

	it('publishes no rank column, because nothing ranked anything', async () => {
		const rows = await db.all(build().toString());
		expect(Object.keys(rows[0])).not.toContain(RANK_COLUMN);
	});

	it('refuses itself when the rows are not grouped', async () => {
		// A raw mark has many rows per category, so the join would succeed and the
		// one-row-per-category claim would be a lie.
		const raw = Query.from('sales_p').select({ x: column('category_idx'), y2: column('revenue') });
		const out = (withDenseCategories([])[0] as SqlTransform).apply(raw, {
			...markConfig,
			groupKeys: null
		} as MarkConfig);
		expect(out.toString()).toBe(raw.toString());
	});
});

// ---------------------------------------------------------------------------
// What an absent category gets in each channel
// ---------------------------------------------------------------------------
//
// The distinction that produced wrong colours: a measure and a category id are
// both numbers and want opposite fillers. Zero is the point for a measure — it
// is what makes a bar shrink to nothing — and zero is a REAL CATEGORY for an id
// channel, so it enters the colour scale's domain and shifts every palette rank
// after it. Bars that had not changed were repainted.

describe('dense fills identity channels differently from measures', () => {
	let db: DB;
	const DIM = '__dplot_dim_fill_test';

	beforeAll(async () => {
		db = openDB();
		await db.run(SEED_SQL);
		await db.run(
			`CREATE TABLE "${DIM}" AS
			 SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id
			 FROM (SELECT DISTINCT category AS value FROM sales)`
		);
		await db.run(
			`CREATE TABLE sales_f AS
			 SELECT s.*, COALESCE(d.id, -1) AS category_idx
			 FROM sales s LEFT JOIN "${DIM}" d ON s.category = d.value`
		);
	});
	afterAll(async () => await db.close());

	async function run() {
		// A mark whose colour is the same categorical field as its band — the
		// ordinary "colour the bars by their category" chart.
		const q = Query.from('sales_f')
			.select({
				x: column('category_idx'),
				y2: sum(column('revenue')),
				fill: column('category_idx')
			})
			.groupby(column('category_idx'))
			// Removes one category outright, which is the case that matters: a
			// filter that merely reduces a category still leaves it a row.
			.where(sqlTag`${column('category')} <> ${literal('Electronics')}`);
		const out = (withDenseCategories([])[0] as SqlTransform).apply(q, {
			markType: 'barY',
			table: 'sales_f',
			x: 'x',
			y: 'y2',
			groupKeys: ['x', 'fill'],
			identity: {
				x: { dim: DIM, size: 100, positional: true },
				fill: { dim: DIM, size: 100, positional: false }
			}
		} as MarkConfig);
		return db.all(out.toString());
	}

	it('gives an absent category zero for the measure', async () => {
		// Identified by the band id being one the filter removed, not by anything
		// about the measure — otherwise this asserts its own premise.
		const rows = await run();
		const present = new Set(
			(
				await db.all(
					`SELECT DISTINCT category_idx AS id FROM sales_f WHERE category <> 'Electronics'`
				)
			).map((r) => Number(r.id))
		);
		const absent = rows.filter((r) => !present.has(Number(r.x)));
		expect(absent.length).toBeGreaterThan(0);
		for (const r of absent) expect(Number(r.y2)).toBe(0);
	});

	it('keeps a category its own colour when colour IS the category', async () => {
		// The case a sentinel got wrong. A bar with no data is still on screen
		// while it shrinks, and colouring it "absent" turns it grey on exactly
		// the frame the colour matters. Its id is not unknown — it is the
		// category's own, and the dim has it.
		const rows = await run();
		for (const r of rows) expect(Number(r.fill)).toBe(Number(r.x));
	});

	it('never puts 0 in an id channel for a category that has no data', async () => {
		// 0 is a real category, so it would be indistinguishable from the first
		// one — which is how palette ranks shifted as the filter emptied
		// categories and bars that had not changed were repainted.
		const rows = await run();
		const absent = rows.filter((r) => Number(r.y2) === 0);
		expect(absent.length).toBeGreaterThan(0);
		for (const r of absent) expect(Number(r.fill)).not.toBe(0);
	});

	it('uses the absent sentinel for an id channel from a DIFFERENT field', async () => {
		// No correct value exists there: the category genuinely has no value in
		// that field, so -1 rather than a colour borrowed from somewhere.
		const q = Query.from('sales_f')
			.select({
				x: column('category_idx'),
				y2: sum(column('revenue')),
				fill: sum(column('category_idx'))
			})
			.groupby(column('category_idx'))
			.where(sqlTag`${column('category')} <> ${literal('Electronics')}`);
		const out = (withDenseCategories([])[0] as SqlTransform).apply(q, {
			markType: 'barY',
			table: 'sales_f',
			x: 'x',
			y: 'y2',
			groupKeys: ['x'],
			identity: {
				x: { dim: DIM, size: 100, positional: true },
				fill: { dim: '__some_other_dim', size: 3, positional: false }
			}
		} as MarkConfig);
		const rows = await db.all(out.toString());
		const absent = rows.filter((r) => Number(r.y2) === 0);
		expect(absent.length).toBeGreaterThan(0);
		for (const r of absent) expect(Number(r.fill)).toBe(-1);
	});
});

// ---------------------------------------------------------------------------
// dense with a series channel: grouped topN, and pairs rather than categories
// ---------------------------------------------------------------------------
//
// A bar mark coloured by a DIFFERENT field has one row per (category, series)
// pair. Two things follow, and both were visible on /test/top-n chart 6:
//
// - the grouped topN published no rank, so the only mechanism that tells the
//   axis "returned but not displayed" had nothing to mark padded rows with, and
//   the axis listed every category in the dim — a reserved Other included;
// - densifying categories does not restore missing PAIRS, so a filter that
//   empties one shifted every row after it, and the renderer's alignment guard
//   snapped instead of animating.

describe('dense with a series channel', () => {
	let db: DB;
	const CAT = '__dplot_dim_series_category';
	const REG = '__dplot_dim_series_region';
	let otherId: number;

	beforeAll(async () => {
		db = openDB();
		await db.run(SEED_SQL);
		await db.run(
			`CREATE TABLE "${CAT}" AS
			 SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id
			 FROM (SELECT DISTINCT category AS value FROM sales)`
		);
		// A synthetic Other, reserved by some other mark on the same field. No
		// row in the data carries it.
		const [{ n }] = await db.all(`SELECT COUNT(*)::INT AS n FROM "${CAT}"`);
		otherId = Number(n);
		await db.run(`INSERT INTO "${CAT}" VALUES ('Other', ${otherId})`);
		await db.run(
			`CREATE TABLE "${REG}" AS
			 SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id
			 FROM (SELECT DISTINCT region AS value FROM sales)`
		);
		await db.run(
			`CREATE TABLE sales_s AS
			 SELECT s.*, c.id AS category_idx, r.id AS region_idx
			 FROM sales s JOIN "${CAT}" c ON s.category = c.value JOIN "${REG}" r ON s.region = r.value`
		);
	});
	afterAll(async () => await db.close());

	const config = {
		markType: 'barY',
		table: 'sales_s',
		x: 'x',
		y: 'y2',
		fill: 'fill',
		identity: {
			x: { dim: CAT, size: 11, positional: true },
			fill: { dim: REG, size: 3, positional: false }
		},
		groupKeys: ['x', 'fill']
	} as MarkConfig;

	/** The shape chart 6 emits — grouped topN, dense, stack — ordered as assembleQuery orders it. */
	async function run(where: string | null) {
		let q = Query.from('sales_s')
			.select({
				x: column('category_idx'),
				y2: sum(column('revenue')),
				fill: column('region_idx')
			})
			.groupby(column('category_idx'), column('region_idx')) as SelectQuery;
		if (where) q = q.where(sqlTag([where] as unknown as TemplateStringsArray)) as SelectQuery;
		for (const t of withDenseCategories([topN(5, { by: 'y2' }), stackY()])) {
			q = (t as SqlTransform).apply(q, config);
		}
		return db.all(`SELECT * FROM (${q}) ORDER BY x, fill`);
	}

	async function expectedTop5(where: string | null) {
		const rows = await db.all(
			`SELECT category_idx AS id FROM sales_s ${where ? `WHERE ${where}` : ''}
			 GROUP BY category_idx ORDER BY SUM(revenue) DESC, category_idx LIMIT 5`
		);
		return rows.map((r) => Number(r.id));
	}

	it('shows the axis the top n only, in rank order, not every category in the dim', async () => {
		for (const where of [null, `region = 'North'`]) {
			const rows = await run(where);
			const ids = extractIdsRankedFromData(rowsToAccessor(rows), 'x', RANK_COLUMN);
			expect(ids).toEqual(await expectedTop5(where));
		}
	});

	it('never displays a synthetic row no data carries', async () => {
		const rows = await run(null);
		expect(rows.some((r) => Number(r.x) === otherId)).toBe(true);
		const ids = extractIdsRankedFromData(rowsToAccessor(rows), 'x', RANK_COLUMN);
		expect(ids).not.toContain(otherId);
	});

	it('returns the same (category, series) rows whether or not a filter empties pairs', async () => {
		// The alignment the renderer checks: row i is the same pair on every
		// update. Excluding a region empties every pair that region had.
		const key = (rows: Record<string, unknown>[]) => rows.map((r) => `${r.x}:${r.fill}`);
		const all = await run(null);
		const withoutNorth = await run(`region <> 'North'`);
		expect(key(withoutNorth)).toEqual(key(all));
		// 11 categories (Other included) x 3 regions, plus a -1 series per
		// category: a row whose series is NULL carries -1, and is padded like any
		// other pair rather than dropped by the join.
		expect(all.length).toBe(11 * (3 + 1));
	});

	it('pads an emptied pair at zero, under its own series id rather than a sentinel', async () => {
		const [{ id: north }] = await db.all(`SELECT id FROM "${REG}" WHERE value = 'North'`);
		const rows = await run(`region <> 'North'`);
		const padded = rows.filter((r) => Number(r.fill) === Number(north));
		expect(padded.length).toBe(11);
		for (const r of padded) {
			expect(Number(r.y2)).toBe(0);
			expect(Number.isFinite(Number(r[RANK_COLUMN]))).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// topN includeOthers, in SQL
// ---------------------------------------------------------------------------
//
// Other used to exist only on the JS path, which `dense()` does not follow, so
// a chart with an Other bucket could not animate at all. In SQL it is a bucket
// and a GROUP BY: past the cutoff the band becomes the reserved id, rows
// collapse per remaining group key, and the rank past the cutoff is n + 1.

describe('topN includeOthers in SQL', () => {
	let db: DB;
	const CAT = '__dplot_dim_others_category';
	const REG = '__dplot_dim_others_region';
	let otherId: number;

	beforeAll(async () => {
		db = openDB();
		await db.run(SEED_SQL);
		await db.run(
			`CREATE TABLE "${CAT}" AS
			 SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id
			 FROM (SELECT DISTINCT category AS value FROM sales)`
		);
		const [{ n }] = await db.all(`SELECT COUNT(*)::INT AS n FROM "${CAT}"`);
		otherId = Number(n);
		await db.run(`INSERT INTO "${CAT}" VALUES ('Other', ${otherId})`);
		await db.run(
			`CREATE TABLE "${REG}" AS
			 SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id
			 FROM (SELECT DISTINCT region AS value FROM sales)`
		);
		await db.run(
			`CREATE TABLE sales_o2 AS
			 SELECT s.*, c.id AS category_idx, r.id AS region_idx
			 FROM sales s JOIN "${CAT}" c ON s.category = c.value JOIN "${REG}" r ON s.region = r.value`
		);
	});
	afterAll(async () => await db.close());

	const isRanked = (r: Record<string, unknown>) => Number.isFinite(Number(r[RANK_COLUMN]));

	async function run(opts: {
		series?: boolean;
		colourIsCategory?: boolean;
		other?: number | null;
		dense?: boolean;
		where?: string;
		n?: number;
	}) {
		const select: Record<string, ExprNode> = {
			x: column('category_idx'),
			y2: sum(column('revenue'))
		};
		const keys = [column('category_idx')];
		const groupKeys = ['x'];
		if (opts.series) {
			select.fill = column('region_idx');
			keys.push(column('region_idx'));
			groupKeys.push('fill');
		}
		if (opts.colourIsCategory) {
			select.fill = column('category_idx');
			groupKeys.push('fill');
		}
		let q = Query.from('sales_o2')
			.select(select)
			.groupby(...keys) as SelectQuery;
		if (opts.where)
			q = q.where(sqlTag([opts.where] as unknown as TemplateStringsArray)) as SelectQuery;

		const other = opts.other === undefined ? otherId : opts.other;
		const config = {
			markType: 'barY',
			table: 'sales_o2',
			x: 'x',
			y: 'y2',
			...(opts.series || opts.colourIsCategory ? { fill: 'fill' } : {}),
			groupKeys,
			identity: {
				x: {
					dim: CAT,
					size: otherId + 1,
					positional: true,
					...(other != null ? { otherId: other } : {})
				},
				...(opts.series ? { fill: { dim: REG, size: 3, positional: false } } : {}),
				...(opts.colourIsCategory
					? { fill: { dim: CAT, size: otherId + 1, positional: false } }
					: {})
			}
		} as MarkConfig;

		const topn = topN(opts.n ?? 5, { by: 'y2', includeOthers: true }) as unknown as SqlTransform;
		expect(topn.stage).toBe('sql');
		const transforms = opts.dense ? withDenseCategories([topn, stackY()]) : [topn];
		for (const t of transforms) q = (t as SqlTransform).apply(q, config);
		return db.all(
			`SELECT * FROM (${q}) ORDER BY x, ${opts.series || opts.colourIsCategory ? 'fill' : 'x'}`
		);
	}

	async function totals(where?: string) {
		const rows = await db.all(
			`SELECT category_idx AS id, SUM(revenue)::DOUBLE AS v FROM sales_o2 ${where ? `WHERE ${where}` : ''}
			 GROUP BY category_idx ORDER BY v DESC, category_idx`
		);
		return rows.map((r) => ({ id: Number(r.id), v: Number(r.v) }));
	}

	it('collapses everything past the cutoff into one Other row, ranked last', async () => {
		const rows = await run({});
		const all = await totals();
		const top = all.slice(0, 5);
		const rest = all.slice(5).reduce((s, r) => s + r.v, 0);

		expect(rows.length).toBe(6);
		const otherRow = rows.find((r) => Number(r.x) === otherId)!;
		expect(Number(otherRow.y2)).toBeCloseTo(rest, 3);
		expect(Number(otherRow[RANK_COLUMN])).toBe(6);
		const ids = extractIdsRankedFromData(rowsToAccessor(rows), 'x', RANK_COLUMN);
		expect(ids).toEqual([...top.map((t) => t.id), otherId]);
	});

	it('keeps one Other row per series, each summing that series past the cutoff', async () => {
		const rows = await run({ series: true });
		const top = new Set((await totals()).slice(0, 5).map((t) => t.id));
		const expected = await db.all(
			`SELECT region_idx AS s, SUM(revenue)::DOUBLE AS v FROM sales_o2
			 WHERE category_idx NOT IN (${[...top].join(',')}) GROUP BY region_idx ORDER BY region_idx`
		);
		const others = rows.filter((r) => Number(r.x) === otherId);
		expect(others.map((r) => Number(r.fill))).toEqual(expected.map((e) => Number(e.s)));
		others.forEach((r, i) => expect(Number(r.y2)).toBeCloseTo(Number(expected[i].v), 3));
		for (const r of rows) {
			if (Number(r.x) !== otherId) expect(top.has(Number(r.x))).toBe(true);
		}
	});

	it('folds into a real category that holds the reserved id and made the cut', async () => {
		// reserveSynthetic reuses a real "Other" rather than duplicating it, so the
		// reserved id can be a category that survives. Its excluded total joins it.
		const all = await totals();
		const winner = all[0];
		const rest = all.slice(5).reduce((s, r) => s + r.v, 0);
		const rows = await run({ other: winner.id });

		expect(rows.length).toBe(5);
		const folded = rows.find((r) => Number(r.x) === winner.id)!;
		expect(Number(folded.y2)).toBeCloseTo(winner.v + rest, 3);
		expect(Number(folded[RANK_COLUMN])).toBe(1);
	});

	it('gives Other its own id in a colour channel from the band dim, not category 0', async () => {
		const rows = await run({ colourIsCategory: true });
		const otherRow = rows.find((r) => Number(r.x) === otherId)!;
		expect(Number(otherRow.fill)).toBe(otherId);
	});

	it('adds no Other row when nothing falls past the cutoff', async () => {
		// Other would be a category standing for zero rows — a claim about the
		// data rather than a summary of it.
		const rows = await run({ n: 20 });
		expect(rows.some((r) => Number(r.x) === otherId)).toBe(false);
		expect(rows.every(isRanked)).toBe(true);
	});

	it('omits the Other rows when no id has been reserved yet', async () => {
		const rows = await run({ other: null });
		expect(rows.length).toBe(5);
		expect(rows.every(isRanked)).toBe(true);
	});

	it('with dense: excluded categories are padded unranked, Other is displayed last', async () => {
		for (const where of [undefined, `region = 'North'`]) {
			const rows = await run({ series: true, dense: true, where });
			const all = await totals(where);
			const ids = extractIdsRankedFromData(rowsToAccessor(rows), 'x', RANK_COLUMN);
			expect(ids).toEqual([...all.slice(0, 5).map((t) => t.id), otherId]);
			// Pairs, as for any series: 11 categories x (3 regions + the NULL -1).
			expect(rows.length).toBe((otherId + 1) * 4);
		}
	});

	// -----------------------------------------------------------------------
	// Other's members: what the click and the share read
	// -----------------------------------------------------------------------

	const idsOf = (r: Record<string, unknown>) =>
		r[OTHER_IDS_COLUMN] == null ? null : (r[OTHER_IDS_COLUMN] as unknown[]).map(Number);
	const valuesOf = (r: Record<string, unknown>) =>
		r[OTHER_VALUES_COLUMN] == null ? null : (r[OTHER_VALUES_COLUMN] as unknown[]).map(Number);

	it('lists the folded categories and their measures on the Other row, by id', async () => {
		const rows = await run({});
		const folded = (await totals()).slice(5).sort((a, b) => a.id - b.id);
		const otherRow = rows.find((r) => Number(r.x) === otherId)!;

		expect(idsOf(otherRow)).toEqual(folded.map((f) => f.id));
		valuesOf(otherRow)!.forEach((v, i) => expect(v).toBeCloseTo(folded[i].v, 3));
		// The values are exactly what Other summed.
		const sum = valuesOf(otherRow)!.reduce((a, b) => a + b, 0);
		expect(sum).toBeCloseTo(Number(otherRow.y2), 3);
		// Every shown row has no members.
		for (const r of rows) if (Number(r.x) !== otherId) expect(idsOf(r)).toBeNull();
	});

	it("lists each series its own members, with that series' measures", async () => {
		const rows = await run({ series: true });
		const top = new Set((await totals()).slice(0, 5).map((t) => t.id));
		const expected = await db.all(
			`SELECT region_idx AS s, category_idx AS c, SUM(revenue)::DOUBLE AS v FROM sales_o2
			 GROUP BY region_idx, category_idx ORDER BY region_idx, category_idx`
		);
		for (const r of rows.filter((r) => Number(r.x) === otherId)) {
			const mine = expected.filter((e) => Number(e.s) === Number(r.fill) && !top.has(Number(e.c)));
			expect(idsOf(r)).toEqual(mine.map((e) => Number(e.c)));
			valuesOf(r)!.forEach((v, i) => expect(v).toBeCloseTo(Number(mine[i].v), 3));
		}
	});

	it("leaves out a category the chart's filters removed: members are what Other summed", async () => {
		// A crossfilter that removes one category entirely, one that would fold.
		const gone = (await totals()).at(-1)!.id;
		const unfiltered = await run({});
		expect(idsOf(unfiltered.find((r) => Number(r.x) === otherId)!)).toContain(gone);

		const where = `category_idx <> ${gone}`;
		const rows = await run({ where });
		const folded = (await totals(where))
			.slice(5)
			.map((f) => f.id)
			.sort((a, b) => a - b);
		const otherRow = rows.find((r) => Number(r.x) === otherId)!;
		expect(idsOf(otherRow)).toEqual(folded);
		expect(idsOf(otherRow)).not.toContain(gone);
	});

	it('lists one entry per category on an ungrouped mark, not one per raw row', async () => {
		// Raw rows, no GROUP BY: topN ranks rows, and every row past the cutoff
		// folds into Other. A category has several such rows; it is listed once,
		// with their sum.
		const raw = await db.all(
			`SELECT category_idx AS c, revenue::DOUBLE AS v FROM sales_o2 ORDER BY v DESC`
		);
		// The top 5 rows have distinct revenues (400, 250, 200, 180, 170), so the
		// cutoff does not depend on how ties are broken.
		const past = raw.slice(5);
		const expected = new Map<number, number>();
		for (const r of past) expected.set(Number(r.c), (expected.get(Number(r.c)) ?? 0) + Number(r.v));

		let q = Query.from('sales_o2').select({
			x: column('category_idx'),
			y2: column('revenue')
		}) as SelectQuery;
		const config = {
			markType: 'dot',
			table: 'sales_o2',
			x: 'x',
			y: 'y2',
			identity: { x: { dim: CAT, size: otherId + 1, positional: true, otherId } }
		} as MarkConfig;
		q = (topN(5, { by: 'y2', includeOthers: true }) as unknown as SqlTransform).apply(q, config);
		const rows = await db.all(String(q));
		const otherRow = rows.find((r) => Number(r.x) === otherId)!;

		const ids = idsOf(otherRow)!;
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([...expected.keys()].sort((a, b) => a - b));
		valuesOf(otherRow)!.forEach((v, i) => expect(v).toBeCloseTo(expected.get(ids[i])!, 3));
		// Bounded by the categories, not the rows, and still what Other summed.
		expect(ids.length).toBeLessThan(past.length);
		const sum = valuesOf(otherRow)!.reduce((a, b) => a + b, 0);
		expect(sum).toBeCloseTo(Number(otherRow.y2), 3);
	});

	it('keeps the lists through dense(), NULL on every padded row', async () => {
		const sparse = await run({});
		const dense = await run({ dense: true });
		const sparseOther = sparse.find((r) => Number(r.x) === otherId)!;
		const denseOthers = dense.filter((r) => Number(r.x) === otherId);
		expect(denseOthers).toHaveLength(1);
		expect(idsOf(denseOthers[0])).toEqual(idsOf(sparseOther));
		for (const r of dense) if (!isRanked(r)) expect(idsOf(r)).toBeNull();
	});

	it('keeps hover tables free of the lists, and works where there are none', async () => {
		for (const other of [otherId, null]) {
			let q = Query.from('sales_o2')
				.select({ x: column('category_idx'), y2: sum(column('revenue')) })
				.groupby(column('category_idx')) as SelectQuery;
			const config = {
				markType: 'barY',
				table: 'sales_o2',
				x: 'x',
				y: 'y2',
				groupKeys: ['x'],
				identity: {
					x: {
						dim: CAT,
						size: otherId + 1,
						positional: true,
						...(other != null ? { otherId: other } : {})
					}
				}
			} as MarkConfig;
			q = (topN(5, { by: 'y2', includeOthers: true }) as unknown as SqlTransform).apply(q, config);
			// As #writeTooltipTable builds it: REPLACE over the filtered columns.
			const rows = await db.all(
				`SELECT * REPLACE (CAST(x AS DOUBLE) AS x) FROM (${withoutOtherMembers(String(q))})`
			);
			expect(rows.length).toBeGreaterThan(0);
			for (const r of rows) {
				expect(OTHER_IDS_COLUMN in r).toBe(false);
				expect(OTHER_VALUES_COLUMN in r).toBe(false);
				expect('y2' in r).toBe(true);
			}
		}
	});
});
