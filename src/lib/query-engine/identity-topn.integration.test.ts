/**
 * Integration test: the identity id contract, end to end through real SQL.
 *
 * The unit tests either side of this seam pass each other consistent data by
 * construction — the transform tests supply their own reserved ids, and
 * the engine tests never see a channel alias. So neither could catch the two
 * defects that actually shipped: a synthetic row fabricating a band value,
 * and the reserved id being published under the source column while
 * the transform looked it up by the data column name.
 *
 * This walks the real chain instead: dim -> view -> the mark's query shape,
 * with the id column aliased to the channel exactly as `#inlineIdentityColumns`
 * aliases it, then through topN and back to a label.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import duckdb from 'duckdb';
import { CategoricalIdentity } from './categorical-identity';
import { topN, RANK_COLUMN, OTHER_IDS_COLUMN, OTHER_VALUES_COLUMN } from '$lib/transforms';
import { Query, column, sql } from '@uwdata/mosaic-sql';
import type { MarkConfig, SqlTransform } from '$lib/types';

interface DB {
	run(sql: string): Promise<void>;
	all(sql: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

function openDB(): DB {
	const db = new duckdb.Database(':memory:');
	return {
		run: (sql: string) =>
			new Promise((res, rej) => db.run(sql, (e: Error | null) => (e ? rej(e) : res()))),
		all: (sql: string) =>
			new Promise((res, rej) =>
				db.all(sql, (e: Error | null, rows: Record<string, unknown>[]) => (e ? rej(e) : res(rows)))
			),
		close: () => new Promise((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
}

describe('identity ids through topN', () => {
	let db: DB;
	let identity: CategoricalIdentity;

	beforeEach(async () => {
		db = openDB();
		identity = new CategoricalIdentity(
			{
				async exec(sql: string | string[]) {
					for (const stmt of Array.isArray(sql) ? sql : [sql]) await db.run(stmt);
				},
				queryRows: (sql: string) => db.all(sql)
			},
			'itest'
		);

		// Four categories with clearly separated totals, so the rank order is
		// unambiguous and DIFFERENT from the alphabetical id order — which is
		// the case the whole design exists for, and the one where a fabricated
		// band value lands on a live category rather than out of range.
		await db.run(`CREATE TABLE sales (category VARCHAR, amount INT)`);
		await db.run(`INSERT INTO sales VALUES
			('alpha', 10), ('bravo', 400), ('charlie', 300), ('delta', 20)`);
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * The mark's query shape — the id column aliased to the channel, grouped —
	 * through topN(2, includeOthers) with the reserved id handed over under the
	 * channel alias, exactly as the lifecycle keys it. Rows in rank order.
	 */
	async function topTwoWithOther(field: string, otherId: number) {
		const idCol = identity.idColumn(field);
		const query = Query.from(identity.sourceFor('sales'))
			.select({
				x: sql`CAST(${column(idCol)} AS REAL)`,
				total: sql`SUM(amount)::REAL`
			})
			.groupby(column(idCol));
		const config = {
			markType: 'bar',
			table: 'sales',
			x: 'x',
			y: 'total',
			groupKeys: ['x'],
			identity: {
				x: { dim: identity.dimTable(field), size: otherId + 1, positional: true, otherId }
			}
		} as MarkConfig;
		const out = (topN(2, { includeOthers: true }) as SqlTransform).apply(query, config);
		const rows = await db.all(`SELECT * FROM (${out}) ORDER BY "${RANK_COLUMN}"`);
		return {
			xs: rows.map((r) => Number(r.x)),
			totals: rows.map((r) => Number(r.total)),
			rows
		};
	}

	it('carries a reserved id through the query and back to its label', async () => {
		await identity.ensureColumns('sales', { categorical: ['category'] });
		const { id: otherId } = await identity.acquireSynthetic('category', 'Other');
		const values = identity.identity('category').values;

		// alpha/bravo/charlie/delta = 0..3 alphabetically; Other is 4.
		expect(otherId).toBe(4);

		const { xs, totals } = await topTwoWithOther('category', otherId);

		// Kept by rank: bravo (400) then charlie (300) — ids 1 and 2, so the
		// display order is not the id order.
		expect(xs.slice(0, 2)).toEqual([1, 2]);
		// The Other row carries the reserved id, not the sum of the excluded
		// ids (0 + 3 = 3, which is delta — a live category).
		expect(xs[2]).toBe(otherId);
		expect(totals[2]).toBe(30);

		// And it decodes through the ordinary accessor, with no special case.
		expect(xs.map((id) => values[id])).toEqual(['bravo', 'charlie', 'Other']);
	});

	it("lists a folded NULL among Other's members, under the NULL category's id", async () => {
		await db.run(`INSERT INTO sales VALUES (NULL, 5)`);
		await identity.ensureColumns('sales', { categorical: ['category'] });
		const bucket = await identity.acquireSynthetic('category', 'Other');
		const nullId = identity.identity('category').nullId!;
		// alpha/bravo/charlie/delta are 0..3, NULL is 4 (last), Other 5.
		expect(nullId).toBe(4);

		const { xs, rows } = await topTwoWithOther('category', bucket.id);
		const other = rows[xs.indexOf(bucket.id)];
		// alpha (0) 10, delta (3) 20, NULL (4) 5, in id order.
		expect((other[OTHER_IDS_COLUMN] as unknown[]).map(Number)).toEqual([0, 3, nullId]);
		expect((other[OTHER_VALUES_COLUMN] as unknown[]).map(Number)).toEqual([10, 20, 5]);
	});

	it('ranks NULL by its measure like any category: the largest takes a slot', async () => {
		await db.run(`INSERT INTO sales VALUES (NULL, 1000)`);
		await identity.ensureColumns('sales', { categorical: ['category'] });
		const bucket = await identity.acquireSynthetic('category', 'Other');
		const values = identity.identity('category').values;

		const { xs, totals } = await topTwoWithOther('category', bucket.id);
		expect(xs.map((id) => values[id])).toEqual([null, 'bravo', 'Other']);
		expect(totals).toEqual([1000, 400, 330]);
	});

	it('keeps a real "Other" a ranked category beside the bucket', async () => {
		// 'Other' exists in the data. It stays a category of its own, ranked like
		// any other, and the bucket takes a label of its own beside it.
		await db.run(`INSERT INTO sales VALUES ('Other', 500)`);
		await identity.ensureColumns('sales', { categorical: ['category'] });
		const bucket = await identity.acquireSynthetic('category', 'Other');
		const values = identity.identity('category').values;

		// Capital O sorts ahead of lowercase, so the real category took id 0.
		const realId = identity.identity('category').ids.get('Other');
		expect(realId).toBe(0);
		expect(bucket.id).not.toBe(realId);
		expect(bucket.label).toBe('Other (rest)');

		const { xs, totals } = await topTwoWithOther('category', bucket.id);

		// The real Other (500) and bravo (400) are the top two; alpha 10 +
		// charlie 300 + delta 20 go to the bucket.
		expect(xs.map((id) => values[id])).toEqual(['Other', 'bravo', 'Other (rest)']);
		expect(totals).toEqual([500, 400, 330]);
	});

	// The two axes this suite and identity-numeric each cover alone: a synthetic
	// bucket, and a dim whose values are not strings. Their PRODUCT was missing,
	// and that is exactly where includeOthers threw — `Conversion Error: Could
	// not convert string 'Other' to INT32` — because the label was written into
	// a `value` column carrying the source column's type. Neither suite was
	// wrong; the gap was between them.
	describe('a synthetic bucket on a non-VARCHAR dim', () => {
		for (const [label, type, values] of [
			['INTEGER', 'INTEGER', '(2021, 10), (2022, 400), (2023, 300)'],
			['BIGINT', 'BIGINT', '(90000000001, 10), (90000000002, 400), (90000000003, 300)'],
			['DATE', 'DATE', `('2024-01-01', 10), ('2024-02-01', 400), ('2024-03-01', 300)`]
		] as const) {
			it(`reserves and labels Other on a ${label} column`, async () => {
				await db.run(`CREATE TABLE t (k ${type}, amount INT)`);
				await db.run(`INSERT INTO t VALUES ${values}`);

				await identity.ensureColumns('t', { categorical: ['k'] });
				const { id: otherId } = await identity.acquireSynthetic('k', 'Other');
				const dim = identity.identity('k');

				// Appended after the three real values, and decodes to its label.
				expect(otherId).toBe(3);
				expect(dim.values[otherId]).toBe('Other');
				expect(dim.synthetic.has(otherId)).toBe(true);

				// The real values kept their own type — the label column exists so
				// that the synthetic row does not force them all to VARCHAR. (A
				// DATE arrives as a JS Date object, not a string and not a number:
				// checked, not assumed, and see the note below about DimValue.)
				expect(dim.values.slice(0, 3).every((v) => typeof v !== 'string')).toBe(true);

				// And the synthetic row still cannot join to a source row.
				const rows = await db.all(`SELECT COUNT(*) AS n FROM "${identity.sourceFor('t')}"`);
				expect(Number(rows[0].n)).toBe(3);
			});
		}

		it('keeps a second synthetic bucket distinct under the unique index', async () => {
			// value is NULL on both, and SQL treats NULLs as distinct, so the
			// unique index on `value` does not reject the second one.
			await db.run(`CREATE TABLE t (k INTEGER)`);
			await db.run(`INSERT INTO t VALUES (1), (2)`);
			await identity.ensureColumns('t', { categorical: ['k'] });

			const { id: other } = await identity.acquireSynthetic('k', 'Other');
			const { id: missing } = await identity.acquireSynthetic('k', 'Missing');

			expect(other).toBe(2);
			expect(missing).toBe(3);
			expect(identity.identity('k').values[missing]).toBe('Missing');
		});
	});

	it('leaves the view queryable after a reservation', async () => {
		// The reserved row has no match in the source, so the LEFT JOIN must not
		// see it — a duplicate value here would fan out every matching row.
		await identity.ensureColumns('sales', { categorical: ['category'] });
		const before = await db.all(`SELECT COUNT(*) AS n FROM "${identity.sourceFor('sales')}"`);

		await identity.acquireSynthetic('category', 'Other');
		const after = await db.all(`SELECT COUNT(*) AS n FROM "${identity.sourceFor('sales')}"`);

		expect(Number(after[0].n)).toBe(Number(before[0].n));
	});
});
