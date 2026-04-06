// src/lib/index.ts
import { setScaleRegistry } from '$lib/scales';
import { setGPUCoordinator } from '$lib/gpu';
import { setQueryContext, initDuckDB } from '$lib/query-engine';
import type { DuckDBConnection } from '$lib/query-engine';

/**
 * Initialize DivePlot: QueryEngine, ScaleRegistry, GPUCoordinator, FilterGroups.
 * Call once in a top-level component's <script> block.
 *
 *   import { initDivePlot } from 'diveplot';
 *   const { queryEngine } = initDivePlot();
 *
 * Pass an existing DuckDB connection to skip internal DuckDB-WASM init:
 *   const { queryEngine } = initDivePlot(myConnection);
 */
export function initDivePlot(connection?: DuckDBConnection | Promise<DuckDBConnection>) {
	const { queryEngine, filterGroups } = setQueryContext(connection ?? initDuckDB());

	const scaleRegistry = setScaleRegistry();
	const gpuCoordinator = setGPUCoordinator({ msaaSampleCount: 4 });

	gpuCoordinator.setScaleRegistry(scaleRegistry);
	scaleRegistry.setGPUCoordinator(gpuCoordinator);

	return { queryEngine, filterGroups, scaleRegistry, gpuCoordinator };
}

export * from './components';
export * from './transforms';
export * from './sql/bin';
export * from './types';

// Spec-driven rendering API
export { DivePlot, render } from './spec';
export type { DivePlotSpec, DivePlotHandle, RenderOptions } from './spec';
