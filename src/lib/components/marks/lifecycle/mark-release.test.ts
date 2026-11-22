/**
 * What a mark gives back to its chart. A lifecycle is replaced (`retire`)
 * whenever the mark's config or scales change, and the successor holds the same
 * mark id: it keeps the mark's extents and scale-type requirements, which the
 * successor registers again. A mark leaving its chart (`destroy`, on unmount)
 * gives them back, or its extent kept the domain wide and its requirement kept
 * deciding the axis type after it was gone.
 */
import { describe, it, expect, vi } from 'vitest';
import { MarkLifecycleV2 } from './MarkLifecycleV2.svelte';
import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';

function lifecycle() {
	const x = new LinearScaleState('x');
	const y = new LinearScaleState('y');
	const requirements = new Map<string, string>();
	const chartContext = {
		chartId: 'chart-1',
		xScaleState: x,
		yScaleState: y,
		facetBandScale: null,
		config: {},
		registerScaleType: vi.fn((dim: string, type: string, _p: number, markId: string) =>
			requirements.set(`${dim}:${markId}`, type)
		),
		unregisterScaleType: vi.fn((dim: string, markId: string) =>
			requirements.delete(`${dim}:${markId}`)
		),
		setParallelColumns: vi.fn()
	};
	const config = {
		markType: 'dot',
		supportedScaleTypes: { x: ['linear'], y: ['linear'] },
		scaleRequirements: {
			x: { type: 'linear', priority: SCALE_PRIORITIES.PREFER },
			y: { type: 'linear', priority: SCALE_PRIORITIES.PREFER }
		},
		table: 'penguins',
		transforms: [],
		select: { x: 'bill_length', y: 'bill_depth' }
	};
	const setup = new MarkLifecycleV2(
		config as never,
		{} as never,
		{ onIdentityReset: () => () => {} } as never,
		chartContext as never,
		'dot-1',
		{} as never
	);
	// What the mark's domain query would have registered under its id.
	x.addMark([32, 60], 'dot-1');
	x.addMark([170, 230], 'dot-2');
	y.addMark([13, 22], 'dot-1');
	return { setup, x, y, requirements, chartContext };
}

describe('a mark leaving its chart', () => {
	it('destroy (unmount) gives back its extents and its scale-type requirements', () => {
		const { setup, x, y, requirements } = lifecycle();
		expect([...requirements.keys()]).toEqual(['x:dot-1', 'y:dot-1']);

		setup.destroy();

		expect(requirements.size).toBe(0);
		// x now spans only the mark that remains; y has none left.
		expect(x.effectiveExtent[0]).toBeGreaterThanOrEqual(170);
		expect(y.hasDomain).toBe(false);
	});

	it('retire (replaced under the same id) keeps them for the successor', () => {
		const { setup, x, requirements } = lifecycle();
		const before = [...x.effectiveExtent];

		setup.retire();

		expect([...requirements.keys()]).toEqual(['x:dot-1', 'y:dot-1']);
		expect([...x.effectiveExtent]).toEqual(before);
	});
});
