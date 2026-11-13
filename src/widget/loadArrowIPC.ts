/**
 * Load Arrow IPC bytes into DuckDB-WASM via insertArrowFromIPCStream.
 *
 * Deduplicates by content hash — if a table with the same name and hash
 * is already loaded, the load is skipped. A per-table promise lock prevents
 * concurrent loads of the same table from racing. Replacing a table's rows
 * (same name, new hash) clears the engine's caches, which would otherwise
 * keep serving results read from the old rows.
 */

import type { QueryEngine } from '$lib/query-engine/QueryEngine';

/** tableName → content hash of the currently loaded data. */
const _loaded = new Map<string, string>();

/** tableName → in-flight load promise (per-table lock). */
const _pending = new Map<string, Promise<void>>();

export async function loadArrowIPCTable(
	queryEngine: QueryEngine,
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

	// Replacing a table this engine already read: new rows under the same name.
	const replacing = _loaded.has(tableName);
	const loadPromise = (async () => {
		await queryEngine.exec(`DROP TABLE IF EXISTS "${tableName}"`);
		await queryEngine.insertArrowFromIPCStream(ipcBytes, {
			name: tableName,
			create: true
		});
		_loaded.set(tableName, hash);
		// Everything read from the old rows under this name is stale: cached
		// results (mark data, domain ranges, sidecars, DESCRIBE), preagg tables
		// and the dims. Whole-engine for now; a per-table invalidation later.
		if (replacing) await queryEngine.clearQueryCache();
	})();

	_pending.set(tableName, loadPromise);
	try {
		await loadPromise;
	} finally {
		_pending.delete(tableName);
	}
}
