/**
 * The rebin watch (AdaptiveBinRung) belongs to the lifecycle: any mark with a
 * bin() channel gets it from the chart's coordinator, without asking for it.
 */

import { describe, it, expect, vi } from 'vitest';
import { count } from '@uwdata/mosaic-sql';
import { MarkLifecycleV2 } from './MarkLifecycleV2.svelte';
import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
import { bin } from '$lib/sql/bin';
import type { LODRung, MarkLODParts, MarkLODSurface } from '$lib/lod/rung-types';

function coordinator() {
	return { addFrameCallback: vi.fn(), removeFrameCallback: vi.fn() };
}

function chart(gpuCoordinator: ReturnType<typeof coordinator> | null) {
	const surfaces = new Map<string, MarkLODSurface>();
	return {
		surfaces,
		adjustBinMultiplier: vi.fn(),
		chartId: 'chart-1',
		xScaleState: new LinearScaleState('v'),
		yScaleState: new LinearScaleState('n'),
		facetBandScale: null,
		scaleTypes: { x: 'linear', y: 'linear' },
		config: {
			entries: new Map(),
			registerMarkLOD: (id: string, surface: MarkLODSurface) => surfaces.set(id, surface),
			unregisterMarkLOD: (id: string) => surfaces.delete(id)
		},
		gpuCoordinator,
		registerScaleType: () => {},
		unregisterScaleType: () => {},
		placeExtent: () => true,
		placeColumnExtent: () => true
	};
}

function lifecycle(
	gpu: ReturnType<typeof coordinator> | null,
	select: Record<string, unknown>,
	config: Record<string, unknown> = {},
	options?: ConstructorParameters<typeof MarkLifecycleV2>[6],
	context = chart(gpu)
) {
	return new MarkLifecycleV2(
		{
			markType: 'recty',
			supportedScaleTypes: { x: ['linear'], y: ['linear'] },
			scaleRequirements: {
				x: { type: 'linear', priority: SCALE_PRIORITIES.PREFER },
				y: { type: 'linear', priority: SCALE_PRIORITIES.PREFER }
			},
			table: 'events',
			transforms: [],
			select,
			...config
		} as never,
		{} as never,
		{ onIdentityReset: () => () => {} } as never,
		context as never,
		'mark-1',
		{ selection: { predicate: () => null } } as never,
		options
	);
}

const BINNED = { x1: bin('v'), x2: bin('v', { offset: 1 }), y: count() };

describe('the rebin watch of a binned mark', () => {
	it('is started for a mark with a bin() channel, from the chart’s coordinator', () => {
		const gpu = coordinator();
		const mark = lifecycle(gpu, BINNED);
		expect(gpu.addFrameCallback).toHaveBeenCalledTimes(1);
		mark.destroy();
		expect(gpu.removeFrameCallback).toHaveBeenCalledTimes(1);
	});

	it('is started for a point over a bin: one binned channel is enough', () => {
		const gpu = coordinator();
		lifecycle(gpu, { x: bin('v'), y: count() }).destroy();
		expect(gpu.addFrameCallback).toHaveBeenCalledTimes(1);
	});

	it('is not started without a bin() channel', () => {
		const gpu = coordinator();
		lifecycle(gpu, { x: 'v', y: 'n' }).destroy();
		expect(gpu.addFrameCallback).not.toHaveBeenCalled();
	});

	it('is not started for a path mark yet, which must stay padded', () => {
		const gpu = coordinator();
		lifecycle(gpu, { x: bin('v'), y: count() }, { _rowLayouts: [] }).destroy();
		expect(gpu.addFrameCallback).not.toHaveBeenCalled();
	});

	it('is left out where the chart has no coordinator', () => {
		expect(() => lifecycle(null, BINNED).destroy()).not.toThrow();
	});
});

describe('a mark’s one LOD surface', () => {
	const rung = (name: string): LODRung => ({
		name,
		kind: 'analytical',
		destroyed: false,
		active: true,
		props: {},
		destroy: () => {}
	});

	it('is registered once for a binned mark, with or without onMarkLOD, and removed on destroy', () => {
		const context = chart(coordinator());
		const mark = lifecycle(context.gpuCoordinator, BINNED, {}, undefined, context);
		const surface = context.surfaces.get('mark-1')!;
		expect(surface.getRungs().map((r) => r.name)).toEqual(['bins']);
		expect(surface.getDensityHost()).toBeNull();
		mark.destroy();
		expect(context.surfaces.size).toBe(0);
	});

	it('tells onMarkLOD of the surface and of its going', () => {
		const context = chart(coordinator());
		const onMarkLOD = vi.fn();
		const mark = lifecycle(context.gpuCoordinator, BINNED, {}, { onMarkLOD }, context);
		expect(onMarkLOD).toHaveBeenLastCalledWith(context.surfaces.get('mark-1'));
		mark.destroy();
		expect(onMarkLOD).toHaveBeenLastCalledWith(null);
	});

	it('lists the bins’ rung and the mark’s own, read when asked', () => {
		const context = chart(coordinator());
		let parts: MarkLODParts | null = { rungs: [null, rung('smooth')], densityHost: null };
		lifecycle(context.gpuCoordinator, BINNED, {}, { lod: () => parts }, context);
		const surface = context.surfaces.get('mark-1')!;
		expect(surface.getRungs().map((r) => r.name)).toEqual(['bins', 'smooth']);
		// A rung built later is seen without registering again.
		parts = { rungs: [rung('dots'), rung('smooth')], densityHost: null };
		expect(surface.getRungs().map((r) => r.name)).toEqual(['bins', 'dots', 'smooth']);
		parts = null;
		expect(surface.getRungs().map((r) => r.name)).toEqual(['bins']);
	});

	it('shift+scroll: the bins take it on a binned mark, the mark’s own rungs without bins', () => {
		const context = chart(coordinator());
		const own = vi.fn();
		const parts = { rungs: [rung('smooth')], densityHost: null, adjustResolution: own };
		lifecycle(context.gpuCoordinator, BINNED, {}, { lod: () => parts }, context);
		context.surfaces.get('mark-1')!.adjustResolution(-100);
		expect(context.adjustBinMultiplier).toHaveBeenCalledTimes(1);
		expect(own).not.toHaveBeenCalled();

		const plain = chart(coordinator());
		lifecycle(plain.gpuCoordinator, { x: 'v', y: 'n' }, {}, { lod: () => parts }, plain);
		plain.surfaces.get('mark-1')!.adjustResolution(-100);
		expect(own).toHaveBeenCalledTimes(1);
		expect(plain.adjustBinMultiplier).not.toHaveBeenCalled();
	});

	it('no surface for a mark with neither bins nor rungs of its own', () => {
		const context = chart(coordinator());
		lifecycle(context.gpuCoordinator, { x: 'v', y: 'n' }, {}, undefined, context);
		expect(context.surfaces.size).toBe(0);
	});
});
