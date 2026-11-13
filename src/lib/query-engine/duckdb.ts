/**
 * DuckDB-WASM initialization — replaces mosaic-core's wasmConnector.
 *
 * initDuckDB() returns a Promise<DuckDBConnection> suitable for passing to
 * setQueryContext(). It loads the jsDelivr bundles unless the app passes its own.
 *
 * connectionFrom() adapts a duckdb-wasm connection the app created itself, for
 * apps that need the AsyncDuckDB instance (registerFileBuffer, extensions, …).
 *
 * Both use the fast IPC query path: bypasses duckdb-wasm's Arrow JS
 * deserialization and returns raw Arrow IPC bytes. QueryEngine decodes them with
 * flechette for zero-copy typed arrays that go straight to GPU buffers.
 */

import type { AsyncDuckDBConnection, DuckDBBundles } from '@duckdb/duckdb-wasm';
import type { DuckDBConnection } from './QueryEngine';
import { PendingQueryLane, type LaneHold, type SlicedLane } from './sliced-lane';

/**
 * How long the worker runs a sliced statement before serving other messages:
 * a quick query on another connection waits at most about this long behind a
 * slow one. Measured in Phase 0: 1 ms at 5 ms, ~50 ms at the default (~100 ms).
 */
export const QUERY_POLLING_INTERVAL_MS = 5;

export interface InitDuckDBOptions {
	/**
	 * DuckDB-WASM bundles to choose from, e.g. served by the app itself:
	 *
	 *   import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
	 *   import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
	 *   …
	 *   initFjader({ bundles: { mvp: { mainModule: mvpWasm, mainWorker: mvpWorker }, eh: … } });
	 *
	 * Only `mvp` is required; selectBundle picks `eh`/`coi` when given and supported.
	 * Relative URLs resolve against the page. Defaults to the jsDelivr bundles.
	 */
	bundles?: DuckDBBundles;
}

/**
 * Adapt a duckdb-wasm connection to the DuckDBConnection QueryEngine expects,
 * with the fast IPC query path, and sliced lanes: further connections on the
 * same database (`openSlicedLane`).
 *
 *   const db = new duckdb.AsyncDuckDB(logger, worker);
 *   await db.instantiate(…);
 *   await db.open({ query: { queryPollingInterval: 5 } }); // short slices, see below
 *   await db.registerFileBuffer('cached.parquet', bytes);
 *   initFjader(connectionFrom(await db.connect(), { pollingIntervalMs: 5 }));
 *
 * Sliced statements run in slices of the database's `queryPollingInterval`.
 * At DuckDB's default (~100 ms) a quick query can wait ~50 ms behind a slow
 * one; open the database with ~5 ms, as `initDuckDB` does. It is a setting of
 * the database, which this function cannot change or read: say what you set
 * as `pollingIntervalMs`. Without it, lanes measure their slices and warn if
 * they run long.
 */
export function connectionFrom(
	conn: AsyncDuckDBConnection,
	options: { pollingIntervalMs?: number } = {}
): DuckDBConnection {
	// useUnsafe + bindings.runQuery bypasses Arrow JS deserialization entirely,
	// returning raw IPC bytes that flechette decodes into zero-copy typed arrays.
	return {
		queryIPC(sql: string): Promise<Uint8Array> {
			return conn.useUnsafe((bindings, connId) => bindings.runQuery(connId, sql));
		},
		query(sql: string) {
			// Fallback: duckdb-wasm returns Apache Arrow Table, structurally
			// compatible with flechette Table at runtime. Only used when
			// queryIPC is unavailable (shouldn't happen with real connections).
			return conn.query(sql) as unknown as ReturnType<DuckDBConnection['query']>;
		},
		async exec(sql: string) {
			await conn.useUnsafe((bindings, connId) => bindings.runQuery(connId, sql));
		},
		close() {
			return conn.close();
		},
		insertArrowFromIPCStream(data: Uint8Array, options: { name: string; create: boolean }) {
			return conn.insertArrowFromIPCStream(data, options);
		},
		async openSlicedLane(laneOptions: { hold?: LaneHold } = {}): Promise<SlicedLane> {
			// Another connection on the same AsyncDuckDB: one catalog, its own
			// pending query.
			const lane = await conn.bindings.connect();
			return lane.useUnsafe(
				(bindings, connId) =>
					new PendingQueryLane(bindings, connId, () => lane.close(), {
						pollingIntervalMs: options.pollingIntervalMs,
						hold: laneOptions.hold
					})
			);
		}
	};
}

/**
 * Initialize DuckDB-WASM and return a connection.
 *
 * Safe to call during SSR — returns a permanently pending promise on the
 * server. The component re-runs on the client where Worker is available.
 *
 * Usage:
 *   const { queryEngine } = setQueryContext(initDuckDB());
 */
export function initDuckDB(options: InitDuckDBOptions = {}): Promise<DuckDBConnection> {
	if (typeof window === 'undefined') {
		// SSR: return pending promise. QueryEngine defers until resolved.
		// Component re-runs on client where the real init happens.
		return new Promise(() => {});
	}
	return doInit(options);
}

async function doInit({ bundles }: InitDuckDBOptions): Promise<DuckDBConnection> {
	const duckdb = await import('@duckdb/duckdb-wasm');
	const bundle = await duckdb.selectBundle(bundles ?? duckdb.getJsDelivrBundles());
	// The worker starts from a blob: URL so a cross-origin (CDN) worker script can
	// load. importScripts there resolves against the blob: URL, so an app's
	// relative bundle URL has to be made absolute first.
	const mainWorker = new URL(bundle.mainWorker!, location.href).href;
	const workerUrl = URL.createObjectURL(
		new Blob([`importScripts(${JSON.stringify(mainWorker)});`], { type: 'text/javascript' })
	);
	const worker = new Worker(workerUrl);
	const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
	try {
		await db.instantiate(
			new URL(bundle.mainModule, location.href).href,
			bundle.pthreadWorker && new URL(bundle.pthreadWorker, location.href).href
		);
	} finally {
		URL.revokeObjectURL(workerUrl);
	}
	// Short slices for sliced lanes. Only the polling interval: the query
	// config's other fields decide how big integers, decimals, timestamps and
	// durations come back, and stay at their defaults.
	await db.open({ query: { queryPollingInterval: QUERY_POLLING_INTERVAL_MS } });
	return connectionFrom(await db.connect(), { pollingIntervalMs: QUERY_POLLING_INTERVAL_MS });
}
