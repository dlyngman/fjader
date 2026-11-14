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
		const engine = new QueryEngine(conn, { mainInFlightCap: 1, mainHold: 'always' });
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

	describe('the hold window (holding while a drain runs)', () => {
		const SEED = `CREATE TABLE t AS SELECT i AS x, CASE WHEN i % 2 = 0 THEN 'a' ELSE 'b' END AS cat FROM range(10) r(i)`;

		/** With one statement held on the connection, whether another is sent rather than held. */
		async function holdsNothing(engine: QueryEngine): Promise<boolean> {
			let release!: () => void;
			conn.gate = new Promise((r) => (release = r));
			conn.gateOn = 'blocker';
			const blocker = engine.query('SELECT 1 AS blocker', { cache: false });
			await vi.waitFor(() => expect(conn.sent.at(-1)).toContain('blocker'));
			const probe = engine.query('SELECT 2 AS probe', { cache: false });
			await new Promise((r) => setTimeout(r, 20));
			const sent = conn.sent.some((s) => s.includes('probe'));
			conn.gate = null;
			release();
			await Promise.all([blocker, probe]);
			return sent;
		}

		it('ends after a drain whose field fails', async () => {
			conn = openConn();
			const engine = new QueryEngine(conn, { mainInFlightCap: 1 });
			await engine.exec(SEED);
			await expect(
				engine.ensureColumns('t', { categorical: ['no_such_column'] })
			).rejects.toThrow();
			expect(await holdsNothing(engine)).toBe(true);
		});

		it('ends after a reset lands mid-drain', async () => {
			conn = openConn();
			const engine = new QueryEngine(conn, { mainInFlightCap: 1 });
			await engine.exec(SEED);
			const building = engine.ensureColumns('t', { categorical: ['cat'] }).catch((e) => e);
			await vi.waitFor(() => expect(conn.sent.some((s) => s.includes('"cat"'))).toBe(true));
			await engine.clearQueryCache();
			await building;
			expect(await holdsNothing(engine)).toBe(true);
		});
	});
});
