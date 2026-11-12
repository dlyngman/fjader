import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { connectionFrom } from './duckdb';

const setQueryContext = vi.fn((_conn: unknown) => ({ queryEngine: {}, filterGroups: {} }));
const initDuckDB = vi.fn((_opts: unknown) => Promise.resolve('internal'));

vi.mock('$lib/query-engine', async (orig) => ({
	...(await orig<object>()),
	setQueryContext: (conn: unknown) => setQueryContext(conn),
	initDuckDB: (opts: unknown) => initDuckDB(opts)
}));
vi.mock('$lib/scales', () => ({ setScaleRegistry: () => ({ setGPUCoordinator() {} }) }));
vi.mock('$lib/gpu', () => ({
	setGPUCoordinator: () => ({ setScaleRegistry() {}, setFilterGroups() {} })
}));

function fakeConn() {
	const ipc = new Uint8Array([1, 2, 3]);
	const runQuery = vi.fn(() => ipc);
	const conn = {
		useUnsafe: vi.fn((cb: (bindings: unknown, connId: number) => unknown) =>
			Promise.resolve(cb({ runQuery }, 7))
		),
		query: vi.fn(() => Promise.resolve('arrow-table')),
		close: vi.fn(() => Promise.resolve()),
		insertArrowFromIPCStream: vi.fn(() => Promise.resolve())
	};
	return { conn, runQuery, ipc };
}

describe('connectionFrom', () => {
	it('routes queryIPC and exec through the unsafe IPC path', async () => {
		const { conn, runQuery, ipc } = fakeConn();
		const c = connectionFrom(conn as unknown as AsyncDuckDBConnection);
		expect(await c.queryIPC!('SELECT 1')).toBe(ipc);
		expect(await c.exec!('CREATE TABLE t (x INT)')).toBeUndefined();
		expect(runQuery.mock.calls).toEqual([
			[7, 'SELECT 1'],
			[7, 'CREATE TABLE t (x INT)']
		]);
		expect(conn.query).not.toHaveBeenCalled();
	});

	it('forwards query, close and insertArrowFromIPCStream', async () => {
		const { conn } = fakeConn();
		const c = connectionFrom(conn as unknown as AsyncDuckDBConnection);
		const bytes = new Uint8Array(0);
		expect(await c.query('SELECT 2')).toBe('arrow-table');
		await c.insertArrowFromIPCStream!(bytes, { name: 't', create: true });
		await c.close();
		expect(conn.query).toHaveBeenCalledWith('SELECT 2');
		expect(conn.insertArrowFromIPCStream).toHaveBeenCalledWith(bytes, { name: 't', create: true });
		expect(conn.close).toHaveBeenCalled();
	});
});

describe('initFjader argument', () => {
	let initFjader: typeof import('$lib').initFjader;
	// Loading the whole package barrel takes seconds on a busy machine.
	beforeAll(async () => {
		({ initFjader } = await import('$lib'));
	}, 30_000);

	beforeEach(() => {
		setQueryContext.mockClear();
		initDuckDB.mockClear();
	});

	it('initializes DuckDB with jsDelivr defaults when called without arguments', () => {
		initFjader();
		expect(initDuckDB).toHaveBeenCalledWith({ bundles: undefined });
		expect(setQueryContext).toHaveBeenCalledWith(initDuckDB.mock.results[0].value);
	});

	it('passes bundles from an options object to initDuckDB', () => {
		const bundles = { mvp: { mainModule: '/m.wasm', mainWorker: '/w.js' } };
		initFjader({ bundles });
		expect(initDuckDB).toHaveBeenCalledWith({ bundles });
	});

	it('uses a connection, a promise of one, or options.connection as is', () => {
		const conn = connectionFrom(fakeConn().conn as unknown as AsyncDuckDBConnection);
		const pending = Promise.resolve(conn);
		initFjader(conn);
		initFjader(pending);
		initFjader({ connection: conn });
		expect(initDuckDB).not.toHaveBeenCalled();
		expect(setQueryContext.mock.calls).toEqual([[conn], [pending], [conn]]);
	});
});
