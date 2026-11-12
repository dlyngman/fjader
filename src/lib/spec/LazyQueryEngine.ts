/**
 * Lazy singleton QueryEngine for spec-driven rendering.
 *
 * Multiple Fjader.render() calls on the same page share one QueryEngine
 * (and thus one DuckDB instance). Data loading is idempotent —
 * tables already loaded are skipped.
 *
 * DuckDB runs in the browser via @duckdb/duckdb-wasm, loaded from jsDelivr.
 */

import { QueryEngine } from '$lib/query-engine/QueryEngine';
import { initDuckDB } from '$lib/query-engine/duckdb';
import type { DataSpec } from './types';

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
	_engine = new QueryEngine(await initDuckDB());
	return _engine;
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
