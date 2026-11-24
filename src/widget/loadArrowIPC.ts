/**
 * Load Arrow IPC bytes into DuckDB-WASM via insertArrowFromIPCStream.
 *
 * Deduplicates by content hash — if a table with the same name and hash
 * is already loaded, the load is skipped. A per-table promise lock prevents
 * concurrent loads of the same table from racing. Replacing a table's rows
 * (same name, new hash) clears the engine's caches, which would otherwise
 * keep serving results read from the old rows.
 *
 * The insert takes ownership of `ipcBytes`: DuckDB-WASM transfers its buffer to
 * the worker, detaching it for the caller. Callers pass fresh bytes per load
 * (the widget copies each table out of its blob; Streamlit's `serialize()`
 * writes a new buffer per call). A view into a larger buffer is copied first.
 */

import type { QueryEngine } from '$lib/query-engine/QueryEngine';

/** tableName → content hash of the currently loaded data. */
const _loaded = new Map<string, string>();

/** tableName → in-flight load promise (per-table lock). */
const _pending = new Map<string, Promise<void>>();

/** `name\u0000hash` → resolvers waiting for that table to load (whenLoaded). */
const _waiters = new Map<string, (() => void)[]>();

/**
 * Whether this page's engine holds the table with exactly this content. A widget
 * table's name is its content hash (`_df_<hash>`), so a match means the same rows.
 */
export function isLoaded(tableName: string, hash: string): boolean {
	return _loaded.get(tableName) === hash;
}

/** Resolves once the table with this content is loaded, by any widget on the page. */
export function whenLoaded(tableName: string, hash: string): Promise<void> {
	if (isLoaded(tableName, hash)) return Promise.resolve();
	const key = `${tableName}\u0000${hash}`;
	return new Promise((resolve) => {
		const list = _waiters.get(key) ?? [];
		list.push(resolve);
		_waiters.set(key, list);
	});
}

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
	// DuckDB-WASM transfers `bytes.buffer` to its worker, detaching it here. A
	// view into a shared buffer (the widget's concatenated blob) would take
	// every other table's bytes with it, so the insert gets a buffer of its own.
	const owned =
		ipcBytes.byteOffset === 0 && ipcBytes.byteLength === ipcBytes.buffer.byteLength
			? ipcBytes
			: ipcBytes.slice();
	// DuckDB-WASM returns silently on empty input, creating no table: fail here
	// rather than record a table that was never loaded.
	if (owned.byteLength === 0) {
		throw new Error(`No Arrow IPC bytes for table "${tableName}" (detached or empty buffer)`);
	}
	const loadPromise = (async () => {
		await queryEngine.exec(`DROP TABLE IF EXISTS "${tableName}"`);
		await queryEngine.insertArrowFromIPCStream(owned, {
			name: tableName,
			create: true
		});
		_loaded.set(tableName, hash);
		const key = `${tableName}\u0000${hash}`;
		for (const resolve of _waiters.get(key) ?? []) resolve();
		_waiters.delete(key);
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
