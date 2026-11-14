/**
 * The lane safety net (QueryEngine #queryRaw) recognises DuckDB's error for a
 * relation a connection cannot see by its wording. Checked here against real
 * DuckDB, so an upgrade that rewords it fails CI rather than letting reads of
 * TEMP sources fail in an app.
 */
import { describe, it, expect } from 'vitest';
import duckdb from 'duckdb';
import { isMissingRelation } from './QueryEngine';

function errorOf(sql: string): Promise<unknown> {
	const db = new duckdb.Database(':memory:');
	return new Promise((resolve) =>
		db.all(sql, (e: Error | null) => {
			db.close(() => resolve(e));
		})
	);
}

describe('isMissingRelation against DuckDB', () => {
	it("matches DuckDB's error for a missing table", async () => {
		const e = await errorOf('SELECT * FROM no_such_table');
		expect(e).toBeInstanceOf(Error);
		expect(isMissingRelation(e)).toBe(true);
	});

	it('matches it for a TEMP view another connection made', async () => {
		const db = new duckdb.Database(':memory:');
		const a = db.connect();
		const b = db.connect();
		const run = (c: duckdb.Connection, sql: string) =>
			new Promise<unknown>((resolve) => c.all(sql, (e: Error | null) => resolve(e)));
		expect(await run(a, 'CREATE TEMP VIEW tv AS SELECT 1 AS x')).toBeNull();
		const e = await run(b, 'SELECT * FROM tv');
		expect(isMissingRelation(e)).toBe(true);
		await new Promise<void>((r) => db.close(() => r()));
	});

	it('does not match another error', async () => {
		const e = await errorOf('SELECT no_such_column FROM range(1)');
		expect(isMissingRelation(e)).toBe(false);
	});
});
