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

function coordinator() {
	return { addFrameCallback: vi.fn(), removeFrameCallback: vi.fn() };
}

function chart(gpuCoordinator: ReturnType<typeof coordinator> | null) {
	return {
		chartId: 'chart-1',
		xScaleState: new LinearScaleState('v'),
		yScaleState: new LinearScaleState('n'),
		facetBandScale: null,
		scaleTypes: { x: 'linear', y: 'linear' },
		config: {},
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
	config: Record<string, unknown> = {}
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
		chart(gpu) as never,
		'mark-1',
		{ selection: { predicate: () => null } } as never
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
