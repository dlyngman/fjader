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
 * with the fast IPC query path.
 *
 *   const db = new duckdb.AsyncDuckDB(logger, worker);
 *   await db.instantiate(…);
 *   await db.registerFileBuffer('cached.parquet', bytes);
 *   initFjader(connectionFrom(await db.connect()));
 */
export function connectionFrom(conn: AsyncDuckDBConnection): DuckDBConnection {
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
	return connectionFrom(await db.connect());
}
