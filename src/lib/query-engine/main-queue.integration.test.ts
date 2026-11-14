/**
 * Integration test: barriers in the main connection's queue against native
 * DuckDB. An identity reset drops the view and then its dims while a read of
 * the view is still queued behind a statement on the connection; the read
 * must run first, and the dims must go after the view.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import duckdb from 'duckdb';
import { QueryEngine, type DuckDBConnection } from './QueryEngine';

interface GatedConn extends DuckDBConnection {
	sent: string[];
	/** While set, a statement whose text includes `gateOn` waits on it. */
	gate: Promise<void> | null;
	gateOn: string;
	close(): Promise<void>;
}

function openConn(): GatedConn {
	const db = new duckdb.Database(':memory:');
	const conn: GatedConn = {
		sent: [],
		gate: null,
		gateOn: '',
		async query(sql: string) {
			conn.sent.push(sql);
			if (conn.gate && sql.includes(conn.gateOn)) await conn.gate;
			const rows = await new Promise<Record<string, unknown>[]>((res, rej) =>
				db.all(sql, (e: Error | null, r: Record<string, unknown>[]) => (e ? rej(e) : res(r)))
			);
			const plain = rows.map((r) =>
				Object.fromEntries(
					Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
				)
			);
			return Object.assign(plain, { numRows: plain.length, get: (i: number) => plain[i] }) as never;
		},
		async exec(sql: string) {
			conn.sent.push(sql);
			await new Promise<void>((res, rej) =>
				db.exec(sql, (e: Error | null) => (e ? rej(e) : res()))
			);
		},
		close: () =>
			new Promise<void>((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
	return conn;
}

let conn: GatedConn;

afterEach(async () => {
	await conn?.close();
});

describe('main connection queue: barriers', () => {
	it('an identity reset drops the view after its queued read, and the dims after the view', async () => {
		conn = openConn();
		const engine = new QueryEngine(conn, { mainInFlightCap: 1 });
		await engine.exec(
			`CREATE TABLE t AS SELECT i AS x, CASE WHEN i % 2 = 0 THEN 'a' ELSE 'b' END AS cat FROM range(10) r(i)`
		);
		await engine.ensureColumns('t', { categorical: ['cat'] });
		const view = engine.identitySourceFor('t');
		expect(view).not.toBe('t');

		// One statement held on the connection; the view read queues behind it.
		let release!: () => void;
		conn.gate = new Promise((r) => (release = r));
		conn.gateOn = 'held';
		const held = engine.query(`SELECT 1 AS held`, { cache: false });
		await vi.waitFor(() => expect(conn.sent.at(-1)).toContain('held'));
		const read = engine.query(`SELECT count(*) AS n FROM "${view}"`, {
			cache: false,
			callerId: 'mark'
		});
		const reset = engine.clearQueryCache();
		conn.gate = null;
		release();
		await held;

		expect((await read).get(0)).toEqual({ n: 10 });
		await reset;
		const readAt = conn.sent.findIndex((s) => s.includes(`FROM "${view}"`));
		const dropViewAt = conn.sent.findIndex((s) => /^DROP VIEW/i.test(s) && s.includes(view));
		const dropDimAt = conn.sent.findIndex((s) => /^DROP TABLE/i.test(s));
		expect(readAt).toBeGreaterThan(-1);
		expect(dropViewAt).toBeGreaterThan(readAt);
		expect(dropDimAt).toBeGreaterThan(dropViewAt);
	});
});
