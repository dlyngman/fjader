import { describe, it, expect, beforeAll } from 'vitest';
import { BaseGPURenderer } from './BaseGPURenderer.svelte';

/**
 * The pipeline is specialised per scale type, and a chart does not always know
 * its types when a mark mounts: a mark that infers its axis from the table
 * schema registers no requirement until that arrives, so the renderer compiles
 * against the `linear` fallback and — before this — stayed there for good. On a
 * band axis that means no `scaleBand`, so no slot lookup and no `slot < 0`
 * discard: every row drawn, at its raw id, never moving on a reorder.
 *
 * Asserted through what reaches the coordinator, because that is what decides
 * which shader is compiled.
 */

beforeAll(() => {
	(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
		COPY_SRC: 4,
		COPY_DST: 8,
		UNIFORM: 64,
		VERTEX: 32,
		STORAGE: 128
	};
	(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
});

function fakes(scaleTypes: { x?: string; y?: string }) {
	/** Every scale-type pair a pipeline has been acquired for, in order. */
	const acquired: { x: string; y: string }[] = [];
	const plansRebuilt: string[] = [];

	const coordinator = {
		async acquirePipeline(_rendererId: string, _markType: string, types: { x: string; y: string }) {
			acquired.push({ ...types });
			return { pipeline: { id: `${types.x}-${types.y}` }, dataLayout: {} };
		},
		releaseRenderer: () => {},
		rebuildRenderPlan: (chartId: string) => plansRebuilt.push(chartId),
		registerLayer: () => ({ remove: () => {} }),
		invalidateChart: () => {}
	};

	const device = {
		createBuffer: () => ({ destroy() {} }),
		createBindGroup: () => ({}),
		queue: { writeBuffer: () => {} }
	};

	// Mutable, as the real one is: ChartScales resolves types after marks mount.
	const chartContext = { chartId: 'chart-1', scaleTypes };

	const renderer = new BaseGPURenderer(
		'dots',
		{ getDevice: () => device } as never,
		coordinator as never,
		chartContext as never
	);

	const init = {
		dataBindingConfig: [],
		markShaderCode: '',
		vertexBufferLayout: [],
		rendererDefinition: {}
	};

	return { renderer, acquired, plansRebuilt, chartContext, init };
}

describe('a renderer whose chart resolves its scale type late', () => {
	it('compiles against linear while the chart names nothing', async () => {
		// Not the behaviour we want, but the behaviour that exists and is the
		// reason the rest of this matters: the fallback is a guess.
		const { renderer, acquired, init } = fakes({});
		await renderer.initialize(init);
		expect(acquired).toEqual([{ x: 'linear', y: 'linear' }]);
	});

	it('recompiles once the chart says band, and rebuilds the chart plan', async () => {
		const { renderer, acquired, plansRebuilt, chartContext, init } = fakes({});
		await renderer.initialize(init);

		chartContext.scaleTypes.x = 'band';
		await renderer.syncScaleTypes();

		expect(acquired).toEqual([
			{ x: 'linear', y: 'linear' },
			{ x: 'band', y: 'linear' }
		]);
		// Without this the swap is invisible: the render plan caches one pipeline
		// per layer, so the chart would go on drawing through the old one.
		expect(plansRebuilt).toEqual(['chart-1']);
	});

	it('does nothing when the types have not moved', async () => {
		const { renderer, acquired, plansRebuilt, init } = fakes({ x: 'band', y: 'linear' });
		await renderer.initialize(init);
		await renderer.syncScaleTypes();
		await renderer.syncScaleTypes();

		expect(acquired).toEqual([{ x: 'band', y: 'linear' }]);
		expect(plansRebuilt).toEqual([]);
	});

	it('does nothing before the first initialize', async () => {
		// The host's effect can fire before `mount` has built anything.
		const { renderer, acquired, plansRebuilt } = fakes({ x: 'band' });
		await renderer.syncScaleTypes();
		expect(acquired).toEqual([]);
		expect(plansRebuilt).toEqual([]);
	});
});
