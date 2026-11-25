// src/lib/index.ts
import { onDestroy } from 'svelte';
import { setScaleRegistry } from '$lib/scales';
import { setGPUCoordinator } from '$lib/gpu';
import { setQueryContext, initDuckDB } from '$lib/query-engine';
import type { DuckDBConnection, InitDuckDBOptions, QueryEngineOptions } from '$lib/query-engine';

export interface FjaderOptions extends InitDuckDBOptions {
	/** An existing connection (or a promise of one); skips internal DuckDB-WASM init. */
	connection?: DuckDBConnection | Promise<DuckDBConnection>;
	/** Advanced: query engine tuning (see QueryEngineOptions). */
	engine?: QueryEngineOptions;
}

type FjaderInit = DuckDBConnection | Promise<DuckDBConnection> | FjaderOptions;

/** A connection has query(), a promise has then(); anything else is options. */
function toOptions(init: FjaderInit | undefined): FjaderOptions {
	if (!init) return {};
	if ('query' in init || 'then' in init) return { connection: init };
	return init;
}

/**
 * Initialize Fjader: QueryEngine, ScaleRegistry, GPUCoordinator, FilterGroups.
 * Call once in a top-level component's <script> block.
 *
 *   import { initFjader } from '@fjader/svelte';
 *   const { queryEngine } = initFjader();
 *
 * Serve the DuckDB-WASM bundles yourself instead of loading them from jsDelivr:
 *   initFjader({ bundles: { mvp: { mainModule, mainWorker }, eh: { … } } });
 *
 * Pass an existing DuckDB connection to skip internal DuckDB-WASM init, e.g. to
 * keep the AsyncDuckDB instance for registerFileBuffer:
 *   const { queryEngine } = initFjader(connectionFrom(await db.connect()));
 */
export function initFjader(init?: FjaderInit) {
	const { connection, bundles, engine } = toOptions(init);
	const { queryEngine, filterGroups } = setQueryContext(
		connection ?? initDuckDB({ bundles }),
		engine
	);

	const scaleRegistry = setScaleRegistry();
	const gpuCoordinator = setGPUCoordinator({ msaaSampleCount: 4 });

	gpuCoordinator.setScaleRegistry(scaleRegistry);
	gpuCoordinator.setFilterGroups(filterGroups);
	scaleRegistry.setGPUCoordinator(gpuCoordinator);

	// Leaving the page that called initFjader() releases the GPU device, and the
	// DuckDB worker if fjader started it: a connection passed in belongs to the
	// app. After the unmount, not during it: Svelte runs this component's
	// teardown before its children's, and the marks release their renderers and
	// drop their tables through the coordinator and the engine in theirs.
	onDestroy(() =>
		queueMicrotask(() => {
			gpuCoordinator.destroy();
			// In the browser only: on the server the connection never arrives.
			// A failed start has been reported where it failed.
			if (!connection && typeof window !== 'undefined') queryEngine.destroy().catch(() => {});
		})
	);

	return { queryEngine, filterGroups, scaleRegistry, gpuCoordinator };
}

export * from './components';
export * from './transforms';
export * from './sql/bin';
export * from './types';

// Selection state: the registry initFjader() returns, for code outside it (is anything
// brushed? which groups exist?). Read from the same context.
export { getFilterGroups } from '$lib/query-engine';

// DuckDB: adapt an app-owned duckdb-wasm connection for initFjader(connection).
export { connectionFrom } from '$lib/query-engine';
export type { DuckDBConnection, InitDuckDBOptions } from '$lib/query-engine';
export type { FilterGroupRegistry, FilterGroup, FilterItem } from '$lib/query-engine';

// Spec-driven rendering API
export { Fjader, render } from './spec';
export type { FjaderSpec, FjaderHandle, RenderOptions } from './spec';
