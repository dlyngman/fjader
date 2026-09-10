/**
 * Integration test: the identity id contract, end to end through real SQL.
 *
 * The unit tests either side of this seam pass each other consistent data by
 * construction — the transform tests supply their own `otherIdsByColumn`, and
 * the engine tests never see a channel alias. So neither could catch the two
 * defects that actually shipped: a synthetic row fabricating a band value
 * (§16.9), and the reserved id being published under the source column while
 * the transform looked it up by the data column name.
 *
 * This walks the real chain instead: dim -> view -> the mark's query shape,
 * with the id column aliased to the channel exactly as `#inlineIdentityColumns`
 * aliases it, then through topN and back to a label.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import duckdb from 'duckdb';
import { CategoricalIdentity } from './categorical-identity';
import { topN } from '$lib/transforms';
import { ColumnDataAccessor } from '$lib/data/DataAccessor';

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

	/** The mark's query shape: the id column aliased to the channel, grouped. */
	async function fetchChannels(field: string) {
		const idCol = identity.idColumn(field);
		const rows = await db.all(
			`SELECT CAST("${idCol}" AS REAL) AS x, COUNT(*)::REAL AS y, SUM(amount)::REAL AS total ` +
				`FROM "${identity.sourceFor('sales')}" GROUP BY 1 ORDER BY 1`
		);
		return new ColumnDataAccessor(
			{
				x: Float32Array.from(rows.map((r) => Number(r.x))),
				y: Float32Array.from(rows.map((r) => Number(r.y))),
				total: Float32Array.from(rows.map((r) => Number(r.total)))
			},
			rows.length
		);
	}

	it('carries a reserved id through the query and back to its label', async () => {
		await identity.ensureColumns('sales', { categorical: ['category'] });
		const otherId = await identity.reserveSynthetic('category', 'Other');
		const values = identity.identity('category').values;

		// alpha/bravo/charlie/delta = 0..3 alphabetically; Other is 4.
		expect(otherId).toBe(4);

		const data = await fetchChannels('category');
		const result = topN(2, { includeOthers: true }).apply(
			data,
			{ markType: 'bar', table: 'sales', x: 'x', y: 'total' },
			{ otherIdsByColumn: { x: otherId } }
		);

		const xs = Array.from(result.getColumn('x') as Float32Array);
		const totals = Array.from(result.getColumn('total') as Float32Array);

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

	it('folds into a real category that already carries the label', async () => {
		// 'Other' exists in the data, so reserveSynthetic reuses its id rather
		// than duplicating the value — and the transform must add the excluded
		// total into that row rather than emit a second row at the same id.
		await db.run(`INSERT INTO sales VALUES ('Other', 500)`);
		await identity.ensureColumns('sales', { categorical: ['category'] });
		const otherId = await identity.reserveSynthetic('category', 'Other');
		const values = identity.identity('category').values;

		// Capital O sorts ahead of lowercase, so the real category took id 0.
		expect(otherId).toBe(0);
		expect(values.filter((v) => v === 'Other')).toHaveLength(1);

		const data = await fetchChannels('category');
		const result = topN(2, { includeOthers: true }).apply(
			data,
			{ markType: 'bar', table: 'sales', x: 'x', y: 'total' },
			{ otherIdsByColumn: { x: otherId } }
		);

		const xs = Array.from(result.getColumn('x') as Float32Array);
		const totals = Array.from(result.getColumn('total') as Float32Array);

		// Two rows, not three: no duplicate bar in Other's slot.
		expect(result.length).toBe(2);
		expect(new Set(xs).size).toBe(2);
		// Other (500) and bravo (400) survive; alpha 10 + charlie 300 + delta 20
		// fold into Other.
		expect(totals[xs.indexOf(otherId)]).toBe(830);
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
				const otherId = await identity.reserveSynthetic('k', 'Other');
				const dim = identity.identity('k');

				// Appended after the three real values, and decodes to its label.
				expect(otherId).toBe(3);
				expect(dim.values[otherId]).toBe('Other');
				expect(dim.ids.get('Other')).toBe(otherId);

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

			const other = await identity.reserveSynthetic('k', 'Other');
			const missing = await identity.reserveSynthetic('k', 'Missing');

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

		await identity.reserveSynthetic('category', 'Other');
		const after = await db.all(`SELECT COUNT(*) AS n FROM "${identity.sourceFor('sales')}"`);

		expect(Number(after[0].n)).toBe(Number(before[0].n));
	});
});
