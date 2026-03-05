/**
 * Lazy singleton Mosaic Coordinator for spec-driven rendering.
 *
 * Multiple DivePlot.render() calls on the same page share one coordinator
 * (and thus one DuckDB-WASM instance). Data loading is idempotent —
 * tables already loaded are skipped.
 */

import type { Coordinator } from '@uwdata/mosaic-core';
import type { DataSpec } from './types';

/** Optional inline WASM bytes + worker code (for environments where separate assets can't be served). */
let _wasmInline: { wasmBytes: ArrayBuffer; workerCode: string } | null = null;

/**
 * Configure DuckDB-WASM with inline WASM bytes and worker code.
 * For managed hosting (e.g. Snowflake) where separate static assets can't be served.
 * Must be called before any render / getOrCreateCoordinator call.
 */
export function configureWasmInline(inline: { wasmBytes: ArrayBuffer; workerCode: string }): void {
	_wasmInline = inline;
}

let _coordinatorPromise: Promise<Coordinator> | null = null;
let _coordinator: Coordinator | null = null;
const _loadedTablesPerCoordinator = new WeakMap<Coordinator, Set<string>>();

function getLoadedTables(coordinator: Coordinator): Set<string> {
	let tables = _loadedTablesPerCoordinator.get(coordinator);
	if (!tables) {
		tables = new Set<string>();
		_loadedTablesPerCoordinator.set(coordinator, tables);
	}
	return tables;
}

/**
 * Get or lazily create the shared Mosaic Coordinator.
 * If a user-provided coordinator is passed, it is used instead.
 */
export async function getOrCreateCoordinator(userCoordinator?: Coordinator): Promise<Coordinator> {
	if (userCoordinator) return userCoordinator;
	if (_coordinator) return _coordinator;
	if (_coordinatorPromise) return _coordinatorPromise;

	_coordinatorPromise = initCoordinator().catch((err) => {
		// Reset so subsequent calls can retry instead of permanently failing
		_coordinatorPromise = null;
		throw err;
	});
	return _coordinatorPromise;
}

/** Whether the coordinator was initialized via REST (server-side DuckDB). */
let _usingRest = false;

/** Force server-side DuckDB (skip WASM entirely). */
let _forceServer = false;

/** Check whether the coordinator is using the REST fallback. */
export function isUsingRestConnector(): boolean {
	return _usingRest;
}

/** Skip WASM and go straight to server-side DuckDB via REST. */
export function configureForceServer(force: boolean): void {
	_forceServer = force;
}

async function initCoordinator(): Promise<Coordinator> {
	const { Coordinator } = await import('@uwdata/mosaic-core');

	if (_forceServer) {
		console.info('[diveplot] Server-side DuckDB forced via configuration');
		return initFromRest();
	}

	// Try WASM first
	try {
		let wasm;
		if (_wasmInline) {
			wasm = await initFromInlineBundle();
		} else {
			const { wasmConnector } = await import('@uwdata/mosaic-core');
			wasm = wasmConnector();
		}
		const coord = new Coordinator();
		coord.databaseConnector(wasm);
		_coordinator = coord;
		return coord;
	} catch (err) {
		console.warn('[diveplot] WASM init failed, trying server-side DuckDB fallback:', err);
	}

	// Fall back to REST connector (Python-side DuckDB via Tornado handler)
	return initFromRest();
}

async function initFromInlineBundle() {
	const { wasmConnector } = await import('@uwdata/mosaic-core');
	const duckdb = await import('@duckdb/duckdb-wasm');

	const workerUrl = URL.createObjectURL(
		new Blob([_wasmInline!.workerCode], { type: 'text/javascript' })
	);
	const worker = new Worker(workerUrl);
	const logger = new duckdb.VoidLogger();
	const db = new duckdb.AsyncDuckDB(logger, worker);

	const wasmUrl = URL.createObjectURL(
		new Blob([_wasmInline!.wasmBytes], { type: 'application/wasm' })
	);
	await db.instantiate(wasmUrl);

	URL.revokeObjectURL(workerUrl);
	URL.revokeObjectURL(wasmUrl);
	return wasmConnector({ duckdb: db });
}

async function initFromRest(): Promise<Coordinator> {
	const { Coordinator, restConnector } = await import('@uwdata/mosaic-core');
	const uri = `${window.location.origin}/_diveplot/query`;

	// Verify the endpoint exists before committing to it
	const probe = await fetch(uri, { method: 'OPTIONS' }).catch(() => null);
	if (!probe || !probe.ok) {
		throw new Error(
			'[diveplot] WASM init failed and server-side DuckDB endpoint not available at ' + uri
		);
	}

	const rest = restConnector({ uri });
	const coord = new Coordinator();
	coord.databaseConnector(rest);
	_coordinator = coord;
	_usingRest = true;
	return coord;
}

/**
 * Load all data sources from a spec's `data` block.
 * Idempotent: tables already loaded (by name) are skipped.
 */
export async function loadData(
	coordinator: Coordinator,
	dataSpecs: Record<string, DataSpec>,
	baseUrl?: string
): Promise<void> {
	const { loadParquet, loadCSV, loadJSON, loadObjects } = await import('@uwdata/mosaic-sql');

	const resolveUrl = (url: string) => {
		if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/')) {
			return url;
		}
		const base = baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : '');
		return `${base}/${url}`;
	};

	const loadedTables = getLoadedTables(coordinator);

	for (const [tableName, spec] of Object.entries(dataSpecs)) {
		if (loadedTables.has(tableName)) continue;

		if (spec.type === 'parquet' || spec.type === 'csv' || spec.type === 'json') {
			const url = resolveUrl(spec.url);
			let loadFn;
			switch (spec.type) {
				case 'parquet':
					loadFn = loadParquet;
					break;
				case 'csv':
					loadFn = loadCSV;
					break;
				case 'json':
					loadFn = loadJSON;
					break;
			}
			await coordinator.exec(loadFn(tableName, url));
		} else if (spec.type === 'sql') {
			await coordinator.exec(spec.sql);
		} else if (spec.type === 'inline') {
			await coordinator.exec(loadObjects(tableName, spec.values));
		}

		loadedTables.add(tableName);
	}
}
