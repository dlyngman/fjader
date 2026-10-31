/**
 * Lazy singleton QueryEngine for spec-driven rendering.
 *
 * Multiple Fjader.render() calls on the same page share one QueryEngine
 * (and thus one DuckDB instance). Data loading is idempotent —
 * tables already loaded are skipped.
 *
 * Supports three connection modes:
 * - WASM (default): DuckDB runs in-browser via @duckdb/duckdb-wasm
 * - Inline WASM: pre-bundled WASM bytes (for widget embeds)
 * - REST: server-side DuckDB via HTTP (Python Tornado handler)
 */

import { QueryEngine } from '$lib/query-engine/QueryEngine';
import type { DuckDBConnection } from '$lib/query-engine/QueryEngine';
import type { DataSpec } from './types';

// ---------------------------------------------------------------------------
// Configuration (must be set before first getOrCreateQueryEngine call)
// ---------------------------------------------------------------------------

/** Inline WASM bytes + worker code (for environments where separate assets can't be served). */
let _wasmInline: { wasmBytes: ArrayBuffer; workerCode: string } | null = null;

/** Skip WASM and go straight to server-side DuckDB via REST. */
let _forceServer = false;

/** Whether the engine was initialized via REST (server-side DuckDB). */
let _usingRest = false;

export function configureWasmInline(inline: { wasmBytes: ArrayBuffer; workerCode: string }): void {
	_wasmInline = inline;
}

export function configureForceServer(force: boolean): void {
	_forceServer = force;
}

export function isUsingRestConnector(): boolean {
	return _usingRest;
}

// ---------------------------------------------------------------------------
// Singleton QueryEngine
// ---------------------------------------------------------------------------

let _engine: QueryEngine | null = null;
let _enginePromise: Promise<QueryEngine> | null = null;

/**
 * Get or lazily create the shared QueryEngine.
 * If a user-provided QueryEngine is passed, it is used instead.
 */
export async function getOrCreateQueryEngine(userEngine?: QueryEngine): Promise<QueryEngine> {
	if (userEngine) return userEngine;
	if (_engine) return _engine;
	if (_enginePromise) return _enginePromise;

	_enginePromise = initEngine().catch((err) => {
		_enginePromise = null;
		throw err;
	});
	return _enginePromise;
}

async function initEngine(): Promise<QueryEngine> {
	if (_forceServer) {
		console.info('[fjader] Server-side DuckDB forced via configuration');
		return initFromRest();
	}

	// Try WASM first
	try {
		const conn = _wasmInline ? await initFromInlineBundle() : await initFromWasm();
		_engine = new QueryEngine(conn);
		return _engine;
	} catch (err) {
		console.warn('[fjader] WASM init failed, trying server-side DuckDB fallback:', err);
	}

	// Fall back to REST connector
	return initFromRest();
}

// ---------------------------------------------------------------------------
// WASM init (standard CDN bundles)
// ---------------------------------------------------------------------------

async function initFromWasm(): Promise<DuckDBConnection> {
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
	return (await db.connect()) as unknown as DuckDBConnection;
}

// ---------------------------------------------------------------------------
// Inline WASM init (bundled widget)
// ---------------------------------------------------------------------------

async function initFromInlineBundle(): Promise<DuckDBConnection> {
	const duckdb = await import('@duckdb/duckdb-wasm');
	const workerUrl = URL.createObjectURL(
		new Blob([_wasmInline!.workerCode], { type: 'text/javascript' })
	);
	const worker = new Worker(workerUrl);
	const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
	const wasmUrl = URL.createObjectURL(
		new Blob([_wasmInline!.wasmBytes], { type: 'application/wasm' })
	);
	await db.instantiate(wasmUrl);
	URL.revokeObjectURL(workerUrl);
	URL.revokeObjectURL(wasmUrl);
	return (await db.connect()) as unknown as DuckDBConnection;
}

// ---------------------------------------------------------------------------
// REST init (server-side DuckDB via HTTP)
// ---------------------------------------------------------------------------

async function initFromRest(): Promise<QueryEngine> {
	const uri = `${window.location.origin}/_fjader/query`;

	// Verify the endpoint exists before committing
	const probe = await fetch(uri, { method: 'OPTIONS' }).catch(() => null);
	if (!probe || !probe.ok) {
		throw new Error(
			'[fjader] WASM init failed and server-side DuckDB endpoint not available at ' + uri
		);
	}

	const conn = new RestConnection(uri);
	_engine = new QueryEngine(conn);
	_usingRest = true;
	return _engine;
}

/**
 * DuckDBConnection over HTTP — sends SQL to a server-side DuckDB.
 * Protocol matches mosaic-core's restConnector (POST JSON with type + sql).
 */
class RestConnection implements DuckDBConnection {
	#uri: string;
	constructor(uri: string) {
		this.#uri = uri;
	}

	async query(sql: string): Promise<import('@uwdata/flechette').Table> {
		const res = await fetch(this.#uri, {
			method: 'POST',
			mode: 'cors',
			credentials: 'omit',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'arrow', sql })
		});
		if (!res.ok) {
			throw new Error(`Query failed with HTTP status ${res.status}: ${await res.text()}`);
		}
		const { tableFromIPC } = await import('@uwdata/flechette');
		return tableFromIPC(new Uint8Array(await res.arrayBuffer()));
	}

	async exec(sql: string): Promise<void> {
		const res = await fetch(this.#uri, {
			method: 'POST',
			mode: 'cors',
			credentials: 'omit',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'exec', sql })
		});
		if (!res.ok) {
			throw new Error(`Exec failed with HTTP status ${res.status}: ${await res.text()}`);
		}
	}

	async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Data loading (shared across all render calls)
// ---------------------------------------------------------------------------

const _loadedTables = new Set<string>();

/**
 * Load all data sources from a spec's `data` block.
 * Idempotent: tables already loaded (by name) are skipped.
 */
export async function loadData(
	queryEngine: QueryEngine,
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

	for (const [tableName, spec] of Object.entries(dataSpecs)) {
		if (_loadedTables.has(tableName)) continue;

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
			await queryEngine.exec(loadFn(tableName, url).toString());
		} else if (spec.type === 'sql') {
			await queryEngine.exec(spec.sql);
		} else if (spec.type === 'inline') {
			await queryEngine.exec(loadObjects(tableName, spec.values).toString());
		}

		_loadedTables.add(tableName);
	}
}
