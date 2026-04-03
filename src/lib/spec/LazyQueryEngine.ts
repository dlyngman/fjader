/**
 * Lazy singleton QueryEngine for spec-driven rendering.
 *
 * Transition helper: extracts a DuckDB-WASM connection from the Mosaic
 * coordinator's WASM connector. When the Mosaic runtime is fully removed,
 * this module will own DuckDB init directly and LazyCoordinator goes away.
 *
 * Multiple DivePlot.render() calls share one QueryEngine (and thus one
 * DuckDB connection), same as the coordinator singleton.
 */

import type { Coordinator } from '@uwdata/mosaic-core';
import { QueryEngine } from '$lib/query-engine/QueryEngine';
import type { DuckDBConnection } from '$lib/query-engine/QueryEngine';

interface WasmConnector {
	getConnection(): Promise<DuckDBConnection>;
}

let _engine: QueryEngine | null = null;
let _enginePromise: Promise<QueryEngine> | null = null;

/**
 * Get or lazily create the shared QueryEngine.
 * Requires a Mosaic coordinator with a WASM connector (REST not yet supported).
 */
export async function getOrCreateQueryEngine(coordinator: Coordinator): Promise<QueryEngine> {
	if (_engine) return _engine;
	if (_enginePromise) return _enginePromise;

	_enginePromise = createEngine(coordinator).catch((err) => {
		_enginePromise = null;
		throw err;
	});
	return _enginePromise;
}

async function createEngine(coordinator: Coordinator): Promise<QueryEngine> {
	const connector = coordinator.databaseConnector() as unknown as WasmConnector;
	if (!connector?.getConnection) {
		throw new Error(
			'[diveplot] QueryEngine requires a WASM connector. REST connector not yet supported.'
		);
	}
	const connection = await connector.getConnection();
	_engine = new QueryEngine(connection);
	return _engine;
}
