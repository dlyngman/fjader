// src/lib/index.ts
import { setScaleRegistry } from '$lib/scales';
import { setGPUCoordinator } from '$lib/gpu';
import { setQueryContext, initDuckDB } from '$lib/query-engine';
import type { DuckDBConnection } from '$lib/query-engine';

/**
 * Initialize Fjader: QueryEngine, ScaleRegistry, GPUCoordinator, FilterGroups.
 * Call once in a top-level component's <script> block.
 *
 *   import { initFjader } from '@fjader/svelte';
 *   const { queryEngine } = initFjader();
 *
 * Pass an existing DuckDB connection to skip internal DuckDB-WASM init:
 *   const { queryEngine } = initFjader(myConnection);
 */
export function initFjader(connection?: DuckDBConnection | Promise<DuckDBConnection>) {
	const { queryEngine, filterGroups } = setQueryContext(connection ?? initDuckDB());

	const scaleRegistry = setScaleRegistry();
	const gpuCoordinator = setGPUCoordinator({ msaaSampleCount: 4 });

	gpuCoordinator.setScaleRegistry(scaleRegistry);
	gpuCoordinator.setFilterGroups(filterGroups);
	scaleRegistry.setGPUCoordinator(gpuCoordinator);

	return { queryEngine, filterGroups, scaleRegistry, gpuCoordinator };
}

export * from './components';
export * from './transforms';
export * from './sql/bin';
export * from './types';

// Selection state: the registry initFjader() returns, for code outside it (is anything
// brushed? which groups exist?). Read from the same context.
export { getFilterGroups } from '$lib/query-engine';
export type { FilterGroupRegistry, FilterGroup, FilterItem } from '$lib/query-engine';

// Spec-driven rendering API
export { Fjader, render } from './spec';
export type { FjaderSpec, FjaderHandle, RenderOptions } from './spec';
