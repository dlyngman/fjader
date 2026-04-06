/**
 * DuckDB-WASM initialization — replaces mosaic-core's wasmConnector.
 *
 * Returns a Promise<DuckDBConnection> suitable for passing to setQueryContext().
 * Uses jsdelivr CDN bundles (same as mosaic-core's wasmConnector).
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
	return conn as unknown as DuckDBConnection;
}
