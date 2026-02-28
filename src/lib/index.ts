// src/lib/index.js
import { setScaleRegistry } from '$lib/scales';
import { setGPUCoordinator } from '$lib/gpu';

/**
 * Initialize all coordinators for the charting library
 * Call this once at the top level of your application
 */
export function setCoordinators(config: { msaaSampleCount?: number } = {}) {
	const scaleRegistry = setScaleRegistry();
	const gpuCoordinator = setGPUCoordinator({
		msaaSampleCount: config.msaaSampleCount ?? 4
	});

	if (gpuCoordinator && scaleRegistry) {
		gpuCoordinator.setScaleRegistry(scaleRegistry);

		if (scaleRegistry.setGPUCoordinator) {
			scaleRegistry.setGPUCoordinator(gpuCoordinator);
		}

		console.log('✅ DivePlot coordinators connected bidirectionally');
	}

	console.log('✅ DivePlot coordinators initialized');

	return {
		scaleRegistry,
		gpuCoordinator
	};
}

export * from './components';
export * from './transforms';
export * from './sql/bin';
export * from './types';

// Spec-driven rendering API
export { DivePlot, render } from './spec';
export type { DivePlotSpec, DivePlotHandle, RenderOptions } from './spec';
