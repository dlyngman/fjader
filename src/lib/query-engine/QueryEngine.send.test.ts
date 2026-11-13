import { describe, it, expect, vi } from 'vitest';
import { QueryEngine } from './QueryEngine';
import type { DuckDBConnection, StatementRecord } from './QueryEngine';

/**
 * Every statement reaches the connection through one funnel (#send), which
 * statement observers see, with the class its caller gave it.
 */
function fakeConnection(failOn?: string) {
	const sent: string[] = [];
	const conn: DuckDBConnection = {
		async query(sql: string) {
			sent.push(sql);
			if (failOn && sql.includes(failOn)) throw new Error('boom');
			const rows = sql.startsWith('DESCRIBE')
				? [{ column_name: 'a', column_type: 'INTEGER', null: 'YES' }]
				: [];
			return { numRows: rows.length, get: (i: number) => rows[i] } as never;
		},
		async exec(sql: string) {
			sent.push(sql);
			if (failOn && sql.includes(failOn)) throw new Error('boom');
		},
		async insertArrowFromIPCStream() {
			sent.push('insert');
		},
		async close() {}
	};
	return { conn, sent };
}

function observe(engine: QueryEngine) {
	const records: StatementRecord[] = [];
	const off = engine.observeStatements((r) => records.push(r));
	return { records, off };
}

describe('QueryEngine #send funnel', () => {
	it('sends queries, statements, DESCRIBE and Arrow inserts through the observer', async () => {
		const { conn } = fakeConnection();
		const engine = new QueryEngine(conn);
		const { records } = observe(engine);

		await engine.query('SELECT 1', { cache: false });
		await engine.exec(['CREATE TABLE t (a INT)', 'DROP TABLE t']);
		await engine.describe('t');
		await engine.insertArrowFromIPCStream(new Uint8Array(8), { name: 't', create: true });

		expect(records.map((r) => [r.kind, r.sql])).toEqual([
			['query', 'SELECT 1'],
			['exec', 'CREATE TABLE t (a INT)'],
			['exec', 'DROP TABLE t'],
			['describe', 'DESCRIBE "t"'],
			['insert', 'INSERT ARROW INTO "t" (8 bytes)']
		]);
		for (const r of records) expect(r.end).toBeGreaterThanOrEqual(r.start);
	});

	it("defaults to 'interaction' and carries a caller's class", async () => {
		const { conn } = fakeConnection();
		const engine = new QueryEngine(conn);
		const { records } = observe(engine);

		await engine.query('SELECT 1', { cache: false });
		await engine.query('SELECT 2', { cache: false, class: 'background' });
		await engine.query('SELECT 3', { callerId: 'mark-1', cache: false, class: 'background' });
		await engine.exec('CREATE TABLE b (a INT)', { class: 'background' });

		expect(records.map((r) => r.class)).toEqual([
			'interaction',
			'background',
			'background',
			'background'
		]);
	});

	it('records a failed statement and still rejects', async () => {
		const { conn } = fakeConnection('broken');
		const engine = new QueryEngine(conn);
		const { records } = observe(engine);

		await expect(engine.exec('SELECT broken')).rejects.toThrow('boom');
		expect(records).toHaveLength(1);
		expect(String(records[0].error)).toContain('boom');
	});

	it('stops calling an observer once it unsubscribes', async () => {
		const { conn } = fakeConnection();
		const engine = new QueryEngine(conn);
		const { records, off } = observe(engine);

		await engine.exec('SELECT 1');
		off();
		await engine.exec('SELECT 2');
		expect(records).toHaveLength(1);
	});

	it('waits for a connection given as a promise', async () => {
		const { conn, sent } = fakeConnection();
		let resolve!: (c: DuckDBConnection) => void;
		const engine = new QueryEngine(new Promise<DuckDBConnection>((r) => (resolve = r)));
		const done = engine.exec('CREATE TABLE late (a INT)');
		resolve(conn);
		await done;
		expect(sent).toEqual(['CREATE TABLE late (a INT)']);
	});
});

describe('QueryEngine ad-hoc query caching', () => {
	it('shares a running identical query and caches it when asked', async () => {
		const { conn, sent } = fakeConnection();
		const engine = new QueryEngine(conn);
		const q = 'SELECT min(x), max(x) FROM t';
		await Promise.all([engine.query(q, { cache: true }), engine.query(q, { cache: true })]);
		await engine.query(q, { cache: true });
		expect(sent).toEqual([q]);
	});

	it('sends an ad-hoc query every time by default, so an app sees its own writes', async () => {
		const { conn, sent } = fakeConnection();
		const engine = new QueryEngine(conn);
		await engine.query('SELECT count(*) FROM t');
		await engine.query('SELECT count(*) FROM t');
		expect(sent).toEqual(['SELECT count(*) FROM t', 'SELECT count(*) FROM t']);
	});

	it('does not cache a failed shared query', async () => {
		const { conn, sent } = fakeConnection('broken');
		const engine = new QueryEngine(conn);
		await expect(engine.query('SELECT broken', { cache: true })).rejects.toThrow('boom');
		await expect(engine.query('SELECT broken', { cache: true })).rejects.toThrow('boom');
		expect(sent).toEqual(['SELECT broken', 'SELECT broken']);
	});

	it('serves nothing stale across clearQueryCache()', async () => {
		const { conn, sent } = fakeConnection();
		const engine = new QueryEngine(conn);
		await engine.query('SELECT 1', { cache: true });
		await engine.clearQueryCache();
		await engine.query('SELECT 1', { cache: true });
		expect(sent.filter((s) => s === 'SELECT 1')).toHaveLength(2);
	});
});

describe('QueryEngine #send robustness', () => {
	it('a throwing observer neither fails the statement nor stops the others', async () => {
		const { conn } = fakeConnection();
		const engine = new QueryEngine(conn);
		const seen: string[] = [];
		const quiet = console.error;
		console.error = () => {};
		try {
			engine.observeStatements(() => {
				throw new Error('listener bug');
			});
			engine.observeStatements((r) => seen.push(r.sql));
			await expect(engine.exec('SELECT 1')).resolves.toBeUndefined();
			await expect(engine.query('SELECT 2', { cache: false })).resolves.toBeDefined();
		} finally {
			console.error = quiet;
		}
		expect(seen).toEqual(['SELECT 1', 'SELECT 2']);
	});

	it('cache: true honours an already aborted signal', async () => {
		const { conn, sent } = fakeConnection();
		const engine = new QueryEngine(conn);
		const controller = new AbortController();
		controller.abort();
		await expect(
			engine.query('SELECT 1', { cache: true, signal: controller.signal })
		).rejects.toThrow('aborted');
		expect(sent).toEqual([]);
	});
});

describe('QueryEngine.describe', () => {
	it('does not remember a failed DESCRIBE: the table may exist by the next call', async () => {
		let exists = false;
		const conn: DuckDBConnection = {
			async query(sql: string) {
				if (sql.startsWith('DESCRIBE') && !exists) throw new Error('Table does not exist');
				const rows = [{ column_name: 'a', column_type: 'INTEGER', null: 'YES' }];
				return { numRows: rows.length, get: (i: number) => rows[i] } as never;
			},
			async close() {}
		};
		const engine = new QueryEngine(conn);
		await expect(engine.describe('late')).rejects.toThrow('does not exist');
		exists = true;
		await expect(engine.describe('late')).resolves.toEqual([
			{ name: 'a', type: 'INTEGER', nullable: true }
		]);
	});
});

describe('QueryEngine background lane', () => {
	/** A fake lane: records what it ran, in order, into `log`. */
	function fakeLane(log: string[]) {
		return {
			async query(sql: string) {
				log.push(`lane ${sql}`);
				const { tableToIPC, tableFromArrays } = await import('@uwdata/flechette');
				return { ipc: [tableToIPC(tableFromArrays({ a: [1] }), { format: 'stream' })!], polls: 0 };
			},
			async exec(sql: string) {
				log.push(`lane ${sql}`);
				return { polls: 0 };
			},
			async close() {
				log.push('lane close');
			}
		};
	}

	function withLane(open?: () => Promise<unknown>) {
		const log: string[] = [];
		const { conn } = fakeConnection();
		const exec = conn.exec!;
		conn.exec = async (sql) => {
			log.push(`main ${sql}`);
			return exec(sql);
		};
		conn.close = async () => {
			log.push('main close');
		};
		conn.openSlicedLane = (open ?? (async () => fakeLane(log))) as never;
		return { conn, log };
	}

	it('runs background statements on the lane, and everything else on the main connection', async () => {
		const { conn, log } = withLane();
		const engine = new QueryEngine(conn);
		const { records } = observe(engine);

		await engine.exec('CREATE TABLE built AS SELECT 1', { class: 'background' });
		await engine.exec('CREATE TEMP TABLE tt (a INT)', {
			class: 'background',
			connectionLocal: true
		});
		await engine.exec('CREATE TABLE dim (a INT)');
		const t = await engine.query('SELECT count(*) FROM built', { class: 'background' });

		expect(log).toEqual([
			'lane CREATE TABLE built AS SELECT 1',
			'main CREATE TEMP TABLE tt (a INT)',
			'main CREATE TABLE dim (a INT)',
			'lane SELECT count(*) FROM built'
		]);
		expect(t.numRows).toBe(1);
		expect(records.map((r) => r.connection)).toEqual(['lane', 'main', 'main', 'lane']);
	});

	it('keeps everything on the main connection without the capability', async () => {
		const { conn, sent } = fakeConnection();
		const engine = new QueryEngine(conn);
		const { records } = observe(engine);
		await engine.exec('CREATE TABLE built AS SELECT 1', { class: 'background' });
		expect(sent).toEqual(['CREATE TABLE built AS SELECT 1']);
		expect(records[0].connection).toBe('main');
	});

	it('without a lane, keeps the order of statements sent in the same tick', async () => {
		const { conn, sent } = fakeConnection();
		const engine = new QueryEngine(conn);
		// Learn there is no lane.
		await engine.exec('SELECT 0', { class: 'background' });
		sent.length = 0;
		await Promise.all([
			engine.exec('background first', { class: 'background' }),
			engine.exec('interaction second')
		]);
		expect(sent).toEqual(['background first', 'interaction second']);
	});

	it('falls back to the main connection when the lane fails to open', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { conn, log } = withLane(async () => {
			throw new Error('no connect');
		});
		const engine = new QueryEngine(conn);
		await engine.exec('CREATE TABLE built AS SELECT 1', { class: 'background' });
		expect(log).toEqual(['main CREATE TABLE built AS SELECT 1']);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('does not send a statement whose signal is already aborted', async () => {
		const { conn, sent } = fakeConnection();
		const engine = new QueryEngine(conn);
		const ctl = new AbortController();
		ctl.abort();
		await expect(engine.exec('DROP TABLE x', { signal: ctl.signal })).rejects.toThrow();
		expect(sent).toEqual([]);
	});

	it('closes its lanes on destroy: the lane first, then the connection', async () => {
		const { conn, log } = withLane();
		const engine = new QueryEngine(conn);
		await engine.exec('CREATE TABLE built AS SELECT 1', { class: 'background' });
		await engine.destroy();
		expect(log.slice(-2)).toEqual(['lane close', 'main close']);
	});
});

describe('QueryEngine source lanes', () => {
	async function ipc() {
		const { tableToIPC, tableFromArrays } = await import('@uwdata/flechette');
		return tableToIPC(tableFromArrays({ a: [1] }), { format: 'stream' })!;
	}

	/** Lanes that report `polls` per read; `opened` counts connections. */
	function laneConnection(polls: () => number) {
		const log: string[] = [];
		let opened = 0;
		const conn: DuckDBConnection = {
			async query() {
				return { numRows: 0, get: () => undefined } as never;
			},
			async queryIPC(sql: string) {
				log.push(`main ${sql}`);
				return ipc();
			},
			async exec() {},
			async close() {},
			openSlicedLane: async () => {
				const id = opened++;
				return {
					async query(sql: string) {
						log.push(`lane${id} ${sql}`);
						return { ipc: [await ipc()], polls: polls(), execMs: 1 };
					},
					async exec() {
						return { polls: 0 };
					},
					async close() {}
				};
			}
		};
		return { conn, log, opened: () => opened };
	}

	it('reads an unknown source on its lane, then on the main connection once a quick read made it fast', async () => {
		const { conn, log } = laneConnection(() => 0);
		const engine = new QueryEngine(conn);
		await engine.query('SELECT 1', { source: 'flights', data: true });
		await engine.query('SELECT 2', { source: 'flights', data: true });
		expect(log[0]).toMatch(/^lane\d SELECT 1$/);
		expect(log[1]).toBe('main SELECT 2');
	});

	it('keeps a slow source on its lane', async () => {
		const { conn, log } = laneConnection(() => 30);
		const engine = new QueryEngine(conn);
		await engine.query('SELECT 1', { source: 'slow_view', data: true });
		await engine.query('SELECT 2', { source: 'slow_view', data: true });
		expect(log.every((l) => l.startsWith('lane'))).toBe(true);
	});

	it('does not let a setup read (no data flag) mark a source fast', async () => {
		const { conn, log } = laneConnection(() => 0);
		const engine = new QueryEngine(conn);
		await engine.query('SELECT min(v)', { source: 'slow_view' });
		await engine.query('SELECT v', { source: 'slow_view', data: true });
		expect(log.map((l) => l.split(' ')[0].replace(/\d/, ''))).toEqual(['lane', 'lane']);
	});

	it('keeps a read without a source, and a connection-local one, on the main connection', async () => {
		const { conn, log } = laneConnection(() => 0);
		const engine = new QueryEngine(conn);
		await engine.query('SELECT 1');
		await engine.query('SELECT 2', { source: 't', connectionLocal: true });
		expect(log).toEqual(['main SELECT 1', 'main SELECT 2']);
	});

	it('closes the source lanes on destroy', async () => {
		const { conn, opened } = laneConnection(() => 30);
		const engine = new QueryEngine(conn);
		await engine.query('SELECT 1', { source: 'a', data: true });
		await engine.query('SELECT 1', { source: 'b', data: true });
		expect(opened()).toBe(2);
		await engine.destroy();
	});

	it('reads an in-memory base table on the main connection from its first read (the prior)', async () => {
		const { tableToIPC, tableFromArrays } = await import('@uwdata/flechette');
		const { conn, log } = laneConnection(() => 30);
		const ipcOf = conn.queryIPC!;
		conn.queryIPC = async (sql: string) => {
			if (sql.includes('duckdb_tables()')) {
				const t = tableFromArrays({ name: ['flights'], path: [':memory:'], is_table: [true] });
				return tableToIPC(t, { format: 'stream' })!;
			}
			if (sql.startsWith('DESCRIBE')) {
				const t = tableFromArrays({ column_name: ['a'], column_type: ['INTEGER'], null: ['YES'] });
				return tableToIPC(t, { format: 'stream' })!;
			}
			return ipcOf(sql);
		};
		const engine = new QueryEngine(conn);
		await engine.describe('flights');
		log.length = 0;
		await engine.query('SELECT min(a)', { source: 'flights' });
		await engine.query('SELECT a', { source: 'flights', data: true });
		expect(log).toEqual(['main SELECT min(a)', 'main SELECT a']);
	});

	it('reads a source the app calls slow on a lane', async () => {
		const { conn, log } = laneConnection(() => 30);
		const engine = new QueryEngine(conn);
		engine.sourceCost('big', 'slow');
		await engine.query('SELECT a', { source: 'big', data: true });
		expect(log[0]).toMatch(/^lane/);
	});

	it('holds a lane while the main connection is busy, until it has been quiet', async () => {
		let hold: ((maxMs: number) => Promise<void> | null) | undefined;
		let release!: () => void;
		const conn: DuckDBConnection = {
			async query() {
				return { numRows: 0, get: () => undefined } as never;
			},
			async exec() {
				await new Promise<void>((r) => (release = r));
			},
			async close() {},
			openSlicedLane: async (options) => {
				hold = options?.hold;
				return {
					query: async () => ({ ipc: [await ipc()], polls: 0, execMs: 1 }),
					exec: async () => ({ polls: 0 }),
					close: async () => {}
				};
			}
		};
		const engine = new QueryEngine(conn);
		await engine.query('SELECT 1', { source: 'a', data: true });
		expect(hold!(75)).toBeNull();

		const main = engine.exec('CREATE TABLE x (a INT)');
		await new Promise((r) => setTimeout(r, 0));
		let resolved = false;
		hold!(75)!.then(() => (resolved = true));
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(false);
		release();
		await main;
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(true);
	});

	it("does not count a lane's own reads as the main connection being busy", async () => {
		let hold: ((maxMs: number) => Promise<void> | null) | undefined;
		let finish!: () => void;
		const { conn } = laneConnection(() => 30);
		const open = conn.openSlicedLane!;
		conn.openSlicedLane = async (options) => {
			hold = options?.hold;
			const lane = await open(options);
			return {
				...lane,
				query: async (sql: string) => {
					await new Promise<void>((r) => (finish = r));
					return lane.query(sql);
				}
			};
		};
		const engine = new QueryEngine(conn);
		const slow = engine.query('SELECT v', { source: 'slow', data: true });
		await new Promise((r) => setTimeout(r, 5));
		expect(hold!(75)).toBeNull();
		finish();
		await slow;
	});
});
