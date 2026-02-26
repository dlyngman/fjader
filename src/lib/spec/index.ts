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
import { Selection } from '@uwdata/mosaic-core';
import { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
import { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import { getOrCreateCoordinator, loadData } from './LazyCoordinator';
import LayoutFromSpec from './LayoutFromSpec.svelte';
import type { DivePlotSpec, RenderOptions, DivePlotHandle } from './types';

/**
 * Render a DivePlot chart from a JSON spec into a target DOM element.
 *
 * The Mosaic coordinator (DuckDB-WASM) is lazily created as a singleton —
 * multiple render() calls share it. ScaleRegistry and GPUCoordinator are
 * per-call so each chart group gets independent scale/GPU state.
 */
export async function render(
	target: HTMLElement,
	spec: DivePlotSpec,
	options: RenderOptions = {}
): Promise<DivePlotHandle> {
	// 1. Lazy-create or reuse Mosaic coordinator
	const coordinator = await getOrCreateCoordinator(options.coordinator);

	// 2. Load data tables (idempotent)
	if (spec.data) {
		await loadData(coordinator, spec.data, options.baseUrl);
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

	// 4. Resolve params → Selection instances
	const params: Record<string, Selection> = {};
	if (spec.params) {
		for (const [name, paramSpec] of Object.entries(spec.params)) {
			switch (paramSpec.select) {
				case 'crossfilter':
					params[name] = Selection.crossfilter();
					break;
				case 'single':
					params[name] = Selection.single();
					break;
				case 'intersect':
					params[name] = Selection.intersect();
					break;
				case 'union':
					params[name] = Selection.union();
					break;
			}
		}
	}

	// 5. Build context map — injected into Svelte mount() so child components
	//    find these via getContext() calls (same keys as setCoordinators())
	const context = new Map<string, unknown>();
	context.set('mosaic-coordinator', coordinator);
	context.set('gpu-coordinator', gpuCoordinator);
	context.set('scale-registry', scaleRegistry);

	// 6. Mount the Svelte component tree
	const component = mount(LayoutFromSpec, {
		target,
		props: { spec, params },
		context
	});

	// 7. Return handle for cleanup
	return {
		destroy() {
			unmount(component);
			gpuCoordinator.destroy();
		}
	};
}

export const DivePlot = { render };

// Re-export coordinator factory for widget entry
export { getOrCreateCoordinator } from './LazyCoordinator';

// Re-export types
export type { DivePlotSpec, DivePlotHandle, RenderOptions } from './types';
export type { MarkSpec, PlotSpec, DataSpec, TransformSpec, FieldSpec } from './types';
