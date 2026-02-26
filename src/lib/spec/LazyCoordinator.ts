/**
 * Lazy singleton Mosaic Coordinator for spec-driven rendering.
 *
 * Multiple DivePlot.render() calls on the same page share one coordinator
 * (and thus one DuckDB-WASM instance). Data loading is idempotent —
 * tables already loaded are skipped.
 */

import type { Coordinator } from '@uwdata/mosaic-core';
import type { DataSpec } from './types';

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
export async function getOrCreateCoordinator(
	userCoordinator?: Coordinator
): Promise<Coordinator> {
	if (userCoordinator) return userCoordinator;
	if (_coordinator) return _coordinator;
	if (_coordinatorPromise) return _coordinatorPromise;

	_coordinatorPromise = initCoordinator();
	return _coordinatorPromise;
}

async function initCoordinator(): Promise<Coordinator> {
	const { Coordinator, wasmConnector } = await import('@uwdata/mosaic-core');
	const wasm = wasmConnector();
	const coord = new Coordinator();
	coord.databaseConnector(wasm);
	_coordinator = coord;
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
