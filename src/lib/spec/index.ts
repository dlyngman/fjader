/**
 * DivePlot Spec API — render charts from JSON specs.
 *
 * Usage:
 *   import { DivePlot } from 'diveplot';
 *
 *   const handle = await DivePlot.render(element, {
 *     data: { penguins: { url: 'penguins.parquet', type: 'parquet' } },
 *     plot: {
 *       width: 600, height: 400,
 *       marks: [{ mark: 'dot', table: 'penguins', x: 'bill_length_mm', y: 'bill_depth_mm' }]
 *     }
 *   });
 *
 *   handle.destroy(); // cleanup
 */

import { mount, unmount } from 'svelte';
import { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
import { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';
import { getOrCreateQueryEngine, loadData } from './LazyQueryEngine';
import LayoutFromSpec from './LayoutFromSpec.svelte';
import type { DivePlotSpec, RenderOptions, DivePlotHandle } from './types';

/**
 * Render a DivePlot chart from a JSON spec into a target DOM element.
 *
 * The QueryEngine (DuckDB-WASM) is lazily created as a singleton —
 * multiple render() calls share it. ScaleRegistry and GPUCoordinator are
 * per-call so each chart group gets independent scale/GPU state.
 */
export async function render(
	target: HTMLElement,
	spec: DivePlotSpec,
	options: RenderOptions = {}
): Promise<DivePlotHandle> {
	// 1. Lazy-create or reuse QueryEngine
	const queryEngine = await getOrCreateQueryEngine(options.queryEngine);

	// 2. Load data tables (idempotent)
	if (spec.data) {
		await loadData(queryEngine, spec.data, options.baseUrl);
	}

	// 3. Create per-render DivePlot services
	const scaleRegistry = new ScaleRegistry();
	const gpuCoordinator = new GPUCoordinator({ msaaSampleCount: 4 });

	// Wire bidirectional references
	gpuCoordinator.setScaleRegistry(scaleRegistry);
	scaleRegistry.setGPUCoordinator(gpuCoordinator);

	// Initialize GPU (async — waits for WebGPU adapter/device)
	if (typeof window !== 'undefined') {
		await gpuCoordinator.initialize();
	}

	// 4. Build context map — injected into Svelte mount() so child components
	//    find these via getContext() calls (same keys as setCoordinators())
	const filterGroups = new FilterGroupRegistry();
	tableSchemaService.setQueryEngine(queryEngine);
	const context = new Map<string, unknown>();
	context.set('query-engine', queryEngine);
	context.set('filter-groups', filterGroups);
	context.set('gpu-coordinator', gpuCoordinator);
	context.set('scale-registry', scaleRegistry);

	// 5. Mount the Svelte component tree
	const component = mount(LayoutFromSpec, {
		target,
		props: { spec },
		context
	});

	// 6. Return handle for cleanup
	return {
		destroy() {
			unmount(component);
			gpuCoordinator.destroy();
		}
	};
}

export const DivePlot = { render };

// Re-export spec export
export { exportSpec, exportSpecJSON } from './export';

// Re-export types
export type { DivePlotSpec, DivePlotHandle, RenderOptions } from './types';
export type { MarkSpec, PlotSpec, DataSpec, TransformSpec, FieldSpec } from './types';
