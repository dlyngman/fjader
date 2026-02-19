// src/lib/index.js
import { setScaleRegistry } from '$lib/scales';
import { setGPUCoordinator } from '$lib/gpu';

/**
 * Initialize all coordinators for the charting library
 * Call this once at the top level of your application
 *
 * @param {Object} config - Configuration options
 * @param {number} config.msaaSampleCount - MSAA sample count for WebGPU (default: 4)
 * @param {boolean} config.enableDebugging - Enable debugging features (default: true in development)
 * @returns {Object} Coordinator instances for advanced usage
 */

export function setCoordinators(config = {}) {
	const scaleRegistry = setScaleRegistry();
	const gpuCoordinator = setGPUCoordinator({
		msaaSampleCount: config.msaaSampleCount ?? 4,
		enableDebugging: config.enableDebugging !== false
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
