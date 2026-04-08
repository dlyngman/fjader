/**
 * DuckDB-WASM initialization — replaces mosaic-core's wasmConnector.
 *
 * Returns a Promise<DuckDBConnection> suitable for passing to setQueryContext().
 * Uses jsdelivr CDN bundles (same as mosaic-core's wasmConnector).
 *
 * Uses the fast IPC query path: bypasses duckdb-wasm's Arrow JS deserialization
 * and returns raw Arrow IPC bytes. QueryEngine decodes them with flechette for
 * zero-copy typed arrays that go straight to GPU buffers.
 *
 * Safe to call during SSR — returns a permanently pending promise on the
 * server. The component re-runs on the client where Worker is available.
 */

import type { DuckDBConnection } from './QueryEngine';

/**
 * Initialize DuckDB-WASM and return a connection.
 *
 * Usage:
 *   const { queryEngine } = setQueryContext(initDuckDB());
 */
export function initDuckDB(): Promise<DuckDBConnection> {
	if (typeof window === 'undefined') {
		// SSR: return pending promise. QueryEngine defers until resolved.
		// Component re-runs on client where the real init happens.
		return new Promise(() => {});
	}
	return doInit();
}

async function doInit(): Promise<DuckDBConnection> {
	const duckdb = await import('@duckdb/duckdb-wasm');
	const bundles = duckdb.getJsDelivrBundles();
	const bundle = await duckdb.selectBundle(bundles);
	const workerUrl = URL.createObjectURL(
		new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
	);
	const worker = new Worker(workerUrl);
	const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
	await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
	URL.revokeObjectURL(workerUrl);
	const conn = await db.connect();

	// Wrap the duckdb-wasm connection to expose the fast IPC query path.
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
