/**
 * Load Arrow IPC bytes into DuckDB-WASM via insertArrowFromIPCStream.
 *
 * Deduplicates by content hash — if a table with the same name and hash
 * is already loaded, the load is skipped. A per-table promise lock prevents
 * concurrent loads of the same table from racing.
 */

import type { Coordinator } from '@uwdata/mosaic-core';

/** Minimal typing for DuckDB-WASM connector accessed through Mosaic. */
interface DuckDBConnection {
	insertArrowFromIPCStream(
		data: Uint8Array,
		options: { name: string; create: boolean }
	): Promise<void>;
}

interface WasmConnector {
	getConnection(): Promise<DuckDBConnection>;
}

/** tableName → content hash of the currently loaded data. */
const _loaded = new Map<string, string>();

/** tableName → in-flight load promise (per-table lock). */
const _pending = new Map<string, Promise<void>>();

export async function loadArrowIPCTable(
	coordinator: Coordinator,
	tableName: string,
	ipcBytes: Uint8Array,
	hash: string
): Promise<void> {
	// Fast path: already loaded with identical content
	if (_loaded.get(tableName) === hash) return;

	// Wait for any in-flight load of the same table, then re-check
	const pending = _pending.get(tableName);
	if (pending) await pending;
	if (_loaded.get(tableName) === hash) return;

	const loadPromise = (async () => {
		await coordinator.exec(`DROP TABLE IF EXISTS "${tableName}"`);
		const connector = coordinator.databaseConnector() as unknown as WasmConnector;
		const connection = await connector.getConnection();
		await connection.insertArrowFromIPCStream(ipcBytes, {
			name: tableName,
			create: true
		});
		_loaded.set(tableName, hash);
	})();

	_pending.set(tableName, loadPromise);
	try {
		await loadPromise;
	} finally {
		_pending.delete(tableName);
	}
}
