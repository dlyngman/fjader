import { describe, it, expect } from 'vitest';
import { column } from '@uwdata/mosaic-sql';
import { togglePredicate } from './toggle-predicate';

const f = column('f');
const sql = (tuples: unknown[][]) => String(togglePredicate([f], tuples));

describe('togglePredicate, one field', () => {
	it('is an IN over the selected values', () => {
		expect(sql([['a'], ['b']])).toBe(`("f" IN ('a', 'b'))`);
	});

	it('selects the NULL category with IS NOT DISTINCT FROM, never inside IN', () => {
		// NULL = NULL is not true, so `IN (…, NULL)` would select nothing for it.
		const both = sql([['a'], [null]]);
		expect(both).toContain(`"f" IN ('a')`);
		expect(both).toContain(`"f" IS NOT DISTINCT FROM NULL`);
		expect(both).not.toMatch(/IN \([^)]*NULL/);
		expect(sql([[null]])).toBe(`("f" IS NOT DISTINCT FROM NULL)`);
	});
});

describe('togglePredicate against DuckDB', () => {
	it('selects exactly the NULL rows when NULL is selected, beside real values', async () => {
		const duckdb = (await import('duckdb')).default;
		const db = new duckdb.Database(':memory:');
		const all = (q: string) =>
			new Promise<Record<string, unknown>[]>((res, rej) =>
				db.all(q, (e: Error | null, r: Record<string, unknown>[]) => (e ? rej(e) : res(r)))
			);
		await all(`CREATE TABLE t AS SELECT * FROM (VALUES ('a'), ('b'), (NULL), (NULL)) v(f)`);
		const count = async (tuples: unknown[][]) =>
			Number((await all(`SELECT COUNT(*) AS n FROM t WHERE ${sql(tuples)}`))[0].n);
		expect(await count([[null]])).toBe(2);
		expect(await count([['a'], [null]])).toBe(3);
		expect(await count([['a']])).toBe(1);
		db.close();
	});
});
