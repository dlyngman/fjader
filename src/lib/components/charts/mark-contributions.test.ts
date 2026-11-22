/**
 * What a chart's marks contribute, owned by the chart and keyed by mark id.
 * A mark's lifecycle is replaced whenever its config or scales change, and
 * only the mark's unmount ends what it contributed: its extents, its
 * scale-type requirements, its parallel columns.
 */
import { describe, it, expect, vi } from 'vitest';
import { MarkContributions } from './MarkContributions';
import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import { ChartScales } from '$lib/scales/ChartScales.svelte';
import { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
import { MarkLifecycleV2 } from '$lib/components/marks/lifecycle/MarkLifecycleV2.svelte';

describe('MarkContributions', () => {
	it('a move to another scale state takes the mark off the old one', () => {
		const contributions = new MarkContributions();
		const before = new LinearScaleState('species');
		const after = new LinearScaleState('island');
		const remove = vi.spyOn(before, 'removeMark');

		expect(contributions.place('dot-1', 'x', before)).toBe(true);
		before.addMark([0, 10], 'dot-1');
		// Every data update places again on the same state: nothing removed.
		expect(contributions.place('dot-1', 'x', before)).toBe(true);
		expect(remove).not.toHaveBeenCalled();

		expect(contributions.place('dot-1', 'x', after)).toBe(true);
		expect(remove).toHaveBeenCalledWith('dot-1');
	});

	it('release takes the mark off every state, and refuses its later writes', () => {
		const contributions = new MarkContributions();
		const x = new LinearScaleState('x');
		const y = new LinearScaleState('y');
		contributions.place('dot-1', 'x', x);
		x.addMark([0, 10], 'dot-1');
		x.addMark([100, 200], 'dot-2');
		contributions.place('dot-1', 'y', y);
		y.addMark([0, 1], 'dot-1');

		contributions.release('dot-1');

		// x spans only the mark that remains; y has none left.
		expect(x.effectiveExtent[0]).toBeGreaterThanOrEqual(100);
		expect(y.hasDomain).toBe(false);
		// A domain query landing after unmount: refused, so nothing puts it back.
		expect(contributions.departed('dot-1')).toBe(true);
		expect(contributions.place('dot-1', 'x', x)).toBe(false);
	});
});

describe('ChartScales: one requirement per mark per dimension', () => {
	function chartScales() {
		return new ChartScales({
			gpuCoordinator: {} as never,
			scaleRegistry: new ScaleRegistry(),
			layout: { chartId: 'chart-1' } as never
		});
	}

	it('a field change from band to linear replaces the requirement', () => {
		const scales = chartScales();
		scales.registerScaleType('x', 'band', SCALE_PRIORITIES.MANDATE, 'bar-1', {}, 'species');
		// The rebuilt lifecycle, under the same id, now on a numeric column.
		scales.registerScaleType('x', 'linear', SCALE_PRIORITIES.PREFER, 'bar-1', {}, 'bill_length');

		expect(scales.scaleRequirements.x.map((r) => `${r.type}:${r.markId}`)).toEqual([
			'linear:bar-1'
		]);
	});

	it('a repeated identical registration changes nothing; another mark adds its own', () => {
		const scales = chartScales();
		scales.registerScaleType('x', 'band', SCALE_PRIORITIES.MANDATE, 'bar-1', {}, 'species');
		const before = scales.scaleRequirements.x;
		scales.registerScaleType('x', 'band', SCALE_PRIORITIES.MANDATE, 'bar-1', {}, 'species');
		expect(scales.scaleRequirements.x).toBe(before);

		scales.registerScaleType('x', 'band', SCALE_PRIORITIES.MANDATE, 'bar-2', {}, 'species');
		expect(scales.scaleRequirements.x.map((r) => r.markId)).toEqual(['bar-1', 'bar-2']);
	});
});

describe('a lifecycle replaced while its mark stays (a rebuild, or waiting for a schema)', () => {
	it('destroy keeps the mark’s extents and requirements for its successor', () => {
		const x = new LinearScaleState('x');
		const requirements = new Map<string, string>();
		const chartContext = {
			chartId: 'chart-1',
			xScaleState: x,
			yScaleState: null,
			facetBandScale: null,
			config: {},
			registerScaleType: (dim: string, type: string, _p: number, markId: string) =>
				requirements.set(`${dim}:${markId}`, type),
			unregisterScaleType: vi.fn(),
			placeExtent: () => true
		};
		const setup = new MarkLifecycleV2(
			{
				markType: 'dot',
				supportedScaleTypes: { x: ['linear'], y: ['linear'] },
				scaleRequirements: {
					x: { type: 'linear', priority: SCALE_PRIORITIES.PREFER },
					y: null
				},
				table: 'penguins',
				transforms: [],
				select: { x: 'bill_length' }
			} as never,
			{} as never,
			{ onIdentityReset: () => () => {} } as never,
			chartContext as never,
			'dot-1',
			{} as never
		);
		x.addMark([32, 60], 'dot-1');
		const extent = [...x.effectiveExtent];

		setup.destroy();

		expect([...x.effectiveExtent]).toEqual(extent);
		expect([...requirements.keys()]).toEqual(['x:dot-1']);
		expect(chartContext.unregisterScaleType).not.toHaveBeenCalled();
	});
});
