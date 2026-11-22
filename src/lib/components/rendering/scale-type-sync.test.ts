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

type Types = { x: string; y: string };

function fakes(
	scaleTypes: { x?: string; y?: string },
	{ hold, fail }: { hold?: (t: Types) => boolean; fail?: (t: Types) => boolean } = {}
) {
	/** A compile `hold` names waits until `release()` lets the pending ones finish. */
	let pending: (() => void)[] = [];
	const release = async () => {
		const now = pending;
		pending = [];
		for (const finish of now) finish();
		// Let the compiles that were waiting run to their end.
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};

	/** Every scale-type pair a pipeline has been acquired for, in order. */
	const acquired: { x: string; y: string }[] = [];
	const plansRebuilt: string[] = [];
	/** What compiles gave back: everything (`all`), or one pair of types. */
	const released: string[] = [];
	const errors: unknown[] = [];

	const coordinator = {
		async acquirePipeline(_rendererId: string, _markType: string, types: { x: string; y: string }) {
			acquired.push({ ...types });
			if (hold?.(types)) await new Promise<void>((finish) => pending.push(finish));
			if (fail?.(types)) throw new Error(`no pipeline for ${types.x},${types.y}`);
			return { pipeline: { id: `${types.x}-${types.y}` }, dataLayout: {} };
		},
		releaseRenderer: () => released.push('all'),
		releaseRendererTypes: (_id: string, t: Types) => released.push(`${t.x},${t.y}`),
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
		chartContext as never,
		{ onError: (error) => errors.push(error) }
	);

	const init = {
		dataBindingConfig: [],
		markShaderCode: '',
		vertexBufferLayout: [],
		rendererDefinition: {}
	};

	return { renderer, acquired, plansRebuilt, released, errors, chartContext, init, release };
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

describe('a scale type that changes while a compile runs', () => {
	it('ends compiled for the chart’s types when they move away and back mid-compile', async () => {
		// A chart's scales rebuilt from empty: (band, linear) went to (linear,
		// linear) and back before the recompile finished. Compared against the
		// finished pipeline (band), the move back looked like no change, and the
		// recompile then finished for (linear, linear) in a band chart.
		const { renderer, acquired, chartContext, init, release } = fakes(
			{ x: 'band', y: 'linear' },
			{ hold: () => true }
		);
		const mounted = renderer.initialize(init);
		await release();
		await mounted;

		chartContext.scaleTypes.x = 'linear';
		const away = renderer.syncScaleTypes();
		chartContext.scaleTypes.x = 'band';
		const back = renderer.syncScaleTypes();
		await release();
		await release();
		await Promise.all([away, back]);

		expect(acquired.at(-1)).toEqual({ x: 'band', y: 'linear' });
		await renderer.syncScaleTypes();
		// Settled: one more sync compiles nothing.
		expect(acquired.at(-1)).toEqual({ x: 'band', y: 'linear' });
		expect(acquired).toHaveLength(3);
	});

	it('catches up when the types move during the first compile, before any sync can run', async () => {
		const { renderer, acquired, plansRebuilt, chartContext, init, release } = fakes(
			{},
			{ hold: () => true }
		);
		const mounted = renderer.initialize(init);
		// The chart resolves band while the mount's compile (linear) runs; the
		// host's sync finds nothing built yet and returns.
		chartContext.scaleTypes.x = 'band';
		await renderer.syncScaleTypes();
		await release();
		await mounted;
		await release();

		expect(acquired).toEqual([
			{ x: 'linear', y: 'linear' },
			{ x: 'band', y: 'linear' }
		]);
		expect(plansRebuilt).toEqual(['chart-1']);
	});

	it('a superseded compile releases only what it acquired, not the newer compile’s pipeline', async () => {
		// band → linear → band: the linear compile is slow, the band one (cached)
		// finishes first; the linear one, superseded, finishing after it must not
		// take the band pipeline with it.
		const { renderer, acquired, released, chartContext, init, release } = fakes(
			{ x: 'band', y: 'linear' },
			{ hold: (t) => t.x === 'linear' }
		);
		await renderer.initialize(init);
		released.length = 0;

		chartContext.scaleTypes.x = 'linear';
		const away = renderer.syncScaleTypes();
		chartContext.scaleTypes.x = 'band';
		await renderer.syncScaleTypes();
		expect(renderer.resourcesCreated).toBe(true);

		await release();
		await away;
		expect(acquired.at(-1)).toEqual({ x: 'band', y: 'linear' });
		// 'all': the first recompile gave back the mount's pipeline as it started.
		// Then the superseded one gave back its own, linear, and not band.
		expect(released).toEqual(['all', 'linear,linear']);
		expect(renderer.resourcesCreated).toBe(true);
	});
});

describe('a recompile that fails', () => {
	it('reports to onError instead of rejecting, and is retried when the types come back', async () => {
		let failing = true;
		const { renderer, acquired, errors, chartContext, init } = fakes(
			{ x: 'band', y: 'linear' },
			{ fail: (t) => failing && t.x === 'linear' }
		);
		await renderer.initialize(init);

		chartContext.scaleTypes.x = 'linear';
		await expect(renderer.syncScaleTypes()).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);

		// Nothing was built for linear: compared against band, a sync back to
		// linear after the cause is gone compiles again rather than being skipped.
		chartContext.scaleTypes.x = 'band';
		await renderer.syncScaleTypes();
		failing = false;
		chartContext.scaleTypes.x = 'linear';
		await renderer.syncScaleTypes();

		expect(acquired.filter((t) => t.x === 'linear')).toHaveLength(2);
		expect(errors).toHaveLength(1);
	});
});
