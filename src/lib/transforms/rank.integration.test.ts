/**
 * Integration test: the `rank()` transform against native DuckDB.
 *
 * `rank()` is what a mark's `sort` prop becomes: a rank column in the query
 * that draws the mark, read by the band axis the way it reads topN's. It
 * replaced a sidecar query against the unfiltered base table, so the cases
 * here are the ones the sidecar got wrong or could not express — a ranking
 * that follows the filter, a category split across a series, a sort composed
 * with topN and its Other bucket — plus the shapes the routes actually use.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { Query, column, sum, sql as sqlTag, type ExprNode } from '@uwdata/mosaic-sql';
import type { SelectQuery } from '@uwdata/mosaic-sql';
import {
	rank,
	topN,
	stackY,
	dodge,
	withRanking,
	withDenseCategories,
	TransformCompiler,
	RANK_COLUMN
} from './index';
import { buildQueryParts, assembleQuery } from '$lib/components/marks/lifecycle/query-builder';
import type { MarkConfig, NormalizedSortConfig, SqlTransform } from '$lib/types';

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

// Region skew: the ranking under a region filter differs from the unfiltered
// one, which is the case the sidecar could not show.
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

const CAT = '__dplot_dim_rank_category';
const REG = '__dplot_dim_rank_region';

const sortX = (direction: 'asc' | 'desc', channel = 'y'): NormalizedSortConfig => ({
	axis: 'x',
	channel,
	direction
});

describe('rank()', () => {
	let db: DB;
	let otherId: number;

	beforeAll(async () => {
		db = openDB();
		await db.run(SEED_SQL);
		// The dims as categorical-identity builds them: ids by value order, dense
		// from 0, and a synthetic Other appended past the real categories.
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
			`CREATE TABLE sales_v AS
			 SELECT s.*, c.id AS category_idx, r.id AS region_idx
			 FROM sales s JOIN "${CAT}" c ON s.category = c.value JOIN "${REG}" r ON s.region = r.value`
		);
	});
	afterAll(async () => await db.close());

	/** Category ids in the order a reference ORDER BY puts them. */
	async function reference(orderBy: string, where = ''): Promise<number[]> {
		const rows = await db.all(
			`SELECT category_idx AS id, SUM(revenue)::DOUBLE AS v FROM sales_v ${where}
			 GROUP BY category_idx ORDER BY ${orderBy}, category_idx`
		);
		return rows.map((r) => Number(r.id));
	}

	/** Ids in rank order from a result, one per category, NaN ranks left out. */
	function ranked(rows: Record<string, unknown>[]): number[] {
		const best = new Map<number, number>();
		for (const r of rows) {
			const rk = Number(r[RANK_COLUMN]);
			if (!Number.isFinite(rk)) continue;
			const id = Number(r.x);
			best.set(id, Math.min(best.get(id) ?? Infinity, rk));
		}
		return [...best.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
	}

	const config = (extra: Partial<MarkConfig> = {}): MarkConfig =>
		({
			markType: 'barY',
			table: 'sales_v',
			x: 'x',
			y: 'y2',
			groupKeys: ['x'],
			identity: { x: { dim: CAT, size: otherId + 1, positional: true } },
			...extra
		}) as MarkConfig;

	const grouped = (where?: string): SelectQuery => {
		let q = Query.from('sales_v')
			.select({ x: column('category_idx'), y2: sum(column('revenue')) })
			.groupby(column('category_idx')) as SelectQuery;
		if (where) q = q.where(sqlTag([where] as unknown as TemplateStringsArray)) as SelectQuery;
		return q;
	};

	function apply(transforms: SqlTransform[], q: SelectQuery, cfg: MarkConfig): SelectQuery {
		for (const t of transforms) q = t.apply(q, cfg);
		return q;
	}

	it('ranks categories by the measure, descending', async () => {
		const q = apply([rank(sortX('desc'))], grouped(), config());
		const rows = await db.all(q.toString());
		expect(ranked(rows)).toEqual(await reference('v DESC'));
	});

	it('ranks ascending', async () => {
		const q = apply([rank(sortX('asc'))], grouped(), config());
		const rows = await db.all(q.toString());
		expect(ranked(rows)).toEqual(await reference('v ASC'));
	});

	it('follows the filter, which the sidecar it replaced did not', async () => {
		const where = `"region" = 'North'`;
		const q = apply([rank(sortX('desc'))], grouped(where), config());
		const rows = await db.all(q.toString());
		const filtered = await reference('v DESC', `WHERE ${where}`);
		expect(ranked(rows)).toEqual(filtered);
		expect(filtered).not.toEqual(await reference('v DESC'));
	});

	it('resolves an extent channel the way the mark lifecycle names it', async () => {
		// `sort={{ x: 'y' }}` on a bar mark, whose measure is y2.
		const q = apply([rank(sortX('desc', 'y'))], grouped(), config());
		expect(q.toString()).toContain(RANK_COLUMN);
		const rows = await db.all(q.toString());
		expect(ranked(rows)).toEqual(await reference('v DESC'));
	});

	it('leaves the query alone with no sort, no identity, or no such channel', () => {
		const base = grouped();
		expect(apply([rank(null)], base, config()).toString()).toBe(base.toString());
		expect(apply([rank(sortX('desc'))], base, config({ identity: undefined })).toString()).toBe(
			base.toString()
		);
		expect(apply([rank(sortX('desc', 'nope'))], base, config()).toString()).toBe(base.toString());
	});

	it('gives every row of a category one rank, by its total across the series', async () => {
		const q = Query.from('sales_v')
			.select({
				x: column('category_idx'),
				fill: column('region_idx'),
				y2: sum(column('revenue'))
			})
			.groupby(column('category_idx'), column('region_idx')) as SelectQuery;
		const cfg = config({
			fill: 'fill',
			groupKeys: ['x', 'fill'],
			identity: {
				x: { dim: CAT, size: otherId + 1, positional: true },
				fill: { dim: REG, size: 3, positional: false }
			}
		});
		const rows = await db.all(apply([rank(sortX('desc'))], q, cfg).toString());

		// One rank per category, however many rows it has.
		const perCategory = new Map<number, Set<number>>();
		for (const r of rows) {
			const set = perCategory.get(Number(r.x)) ?? new Set();
			set.add(Number(r[RANK_COLUMN]));
			perCategory.set(Number(r.x), set);
		}
		for (const set of perCategory.values()) expect(set.size).toBe(1);
		expect(ranked(rows)).toEqual(await reference('v DESC'));
	});

	it('composes with topN: membership is topN’s, order is the sort’s, padding stays NaN', async () => {
		const transforms = withRanking(
			withDenseCategories([topN(3, { by: 'y2' })]),
			sortX('asc')
		) as SqlTransform[];
		const rows = await db.all(apply(transforms, grouped(), config()).toString());

		const top3 = (await reference('v DESC')).slice(0, 3);
		const order = ranked(rows);
		expect(new Set(order)).toEqual(new Set(top3));
		expect(order).toEqual([...top3].reverse());

		// Every category in the dim is still a row, and the ones past the
		// cutoff carry NaN, which is what keeps them off the axis.
		expect(rows.length).toBe(otherId + 1);
		const padded = rows.filter((r) => !Number.isFinite(Number(r[RANK_COLUMN])));
		expect(padded.length).toBe(otherId + 1 - 3);
		for (const r of padded) expect(Number(r.y2)).toBe(0);
	});

	it('keeps an Other bucket last whatever its total', async () => {
		const cfg = config({
			identity: { x: { dim: CAT, size: otherId + 1, positional: true, otherId } }
		});
		const transforms = withRanking(
			withDenseCategories([topN(3, { by: 'y2', includeOthers: true })]),
			sortX('desc')
		) as SqlTransform[];
		const rows = await db.all(apply(transforms, grouped(), cfg).toString());

		const order = ranked(rows);
		expect(order.length).toBe(4);
		expect(order[3]).toBe(otherId);
		// Other sums seven categories and would lead a descending sort on its own.
		const other = rows.find((r) => Number(r.x) === otherId)!;
		const first = rows.find((r) => Number(r.x) === order[0])!;
		expect(Number(other.y2)).toBeGreaterThan(Number(first.y2));
	});

	it('ranks ungrouped rows by the extreme value, as ORDER BY would', async () => {
		// One row per (category, region): a raw mark. The sidecar ordered rows
		// and took first appearance, which is MIN for asc and MAX for desc.
		const q = Query.from('sales_v').select({
			x: column('category_idx'),
			y: column('revenue')
		}) as SelectQuery;
		const cfg = config({ y: 'y', groupKeys: null });

		const desc = ranked(await db.all(apply([rank(sortX('desc'))], q, cfg).toString()));
		const maxRef = (
			await db.all(
				`SELECT category_idx AS id FROM sales_v GROUP BY category_idx
				 ORDER BY MAX(revenue) DESC, category_idx`
			)
		).map((r) => Number(r.id));
		expect(desc).toEqual(maxRef);

		const asc = ranked(await db.all(apply([rank(sortX('asc'))], q, cfg).toString()));
		const minRef = (
			await db.all(
				`SELECT category_idx AS id FROM sales_v GROUP BY category_idx
				 ORDER BY MIN(revenue) ASC, category_idx`
			)
		).map((r) => Number(r.id));
		expect(asc).toEqual(minRef);
	});

	it('survives the stack wrapper and the outer ordering, through assembleQuery', async () => {
		const compiler = new TransformCompiler(
			withRanking(withDenseCategories([stackY()]), sortX('desc')),
			config()
		);
		const parts = buildQueryParts(
			{ x: column('category_idx'), y2: sum(column('revenue')) } as Record<string, ExprNode>,
			null,
			true
		);
		const q = assembleQuery({ table: 'sales_v', parts, transformCompiler: compiler });
		const text = q.toString();
		expect(text).toContain(RANK_COLUMN);
		const rows = await db.all(text);
		// dense() pads the reserved Other id, which no row carries, at zero; on a
		// plain sorted axis that is a category like any other, and ranks last.
		expect(ranked(rows)).toEqual([...(await reference('v DESC')), otherId]);
		// Rows are still aligned on the band, in id order: the rank is a VALUE.
		expect(rows.map((r) => Number(r.x))).toEqual(rows.map((_, i) => i));
	});

	it('reads a getter when the query is assembled, and says so in its spec', () => {
		let sort: NormalizedSortConfig = sortX('desc');
		const r = rank(() => sort);
		expect(r.spec).toEqual({ transform: 'rank', axis: 'x', by: 'y', direction: 'desc' });
		const before = apply([r], grouped(), config()).toString();

		sort = sortX('asc');
		expect(r.spec).toEqual({ transform: 'rank', axis: 'x', by: 'y', direction: 'asc' });
		expect(apply([r], grouped(), config()).toString()).not.toBe(before);

		sort = null;
		expect(r.spec).toEqual({ transform: 'rank' });
		expect(apply([r], grouped(), config()).toString()).toBe(grouped().toString());
	});
});

describe('withRanking', () => {
	it('appends the rank last among SQL transforms', () => {
		const out = withRanking([topN(3), stackY()], null);
		expect(out.map((t) => t.type)).toEqual(['topN', 'stack', 'rank']);
	});

	it('stays ahead of a JS transform, as staging requires', () => {
		const out = withRanking([topN(3), dodge()], null);
		expect(out.map((t) => t.type)).toEqual(['topN', 'rank', 'dodge']);
		expect(() => new TransformCompiler(out)).not.toThrow();
	});

	it('adds at most one', () => {
		const once = withRanking([], null);
		expect(withRanking(once, null)).toBe(once);
	});
});
