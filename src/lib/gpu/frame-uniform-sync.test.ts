import { describe, it, expect } from 'vitest';
import { frameUniformIsStale, type FrameUniformInputs } from './frame-uniform-sync';

/** A chart whose uniform is up to date with topology 7. */
function settled(over: Partial<FrameUniformInputs> = {}): FrameUniformInputs {
	return {
		xScaleId: 'x-scale',
		yScaleId: 'y-scale',
		facetScale: null,
		_facetVersion: -1,
		_uniformTopology: 7,
		_uniformXScaleId: 'x-scale',
		_uniformYScaleId: 'y-scale',
		...over
	};
}

describe('when a chart frame uniform has stopped describing its chart', () => {
	it('is current when nothing has moved', () => {
		expect(frameUniformIsStale(settled(), 7)).toBe(false);
	});

	it('notices a scale the chart did not have when it was written', () => {
		// setChartScaleMapping assigns the ids and nothing else. Before the
		// reconcile it also had to rewrite the uniform, and did not — which is
		// how a chart came to render through the scale at index 0.
		expect(frameUniformIsStale(settled({ xScaleId: 'another-scale' }), 7)).toBe(true);
		expect(frameUniformIsStale(settled({ yScaleId: 'another-scale' }), 7)).toBe(true);
	});

	it('notices a rebuild even when the chart holds the very same scales', () => {
		// The clause that looks redundant and is not. The uniform holds an
		// INDEX, and indices are positional: a rebuild can move this chart's
		// scale to a different slot without its ids changing by a character.
		// Comparing ids alone sees a settled chart while every shader on it
		// reads another scale's params.
		expect(frameUniformIsStale(settled(), 8)).toBe(true);
	});

	it('notices a facet permutation moving under a cell', () => {
		const chart = settled({ facetScale: { _version: 4 }, _facetVersion: 3 });
		expect(frameUniformIsStale(chart, 7)).toBe(true);

		chart._facetVersion = 4;
		expect(frameUniformIsStale(chart, 7)).toBe(false);
	});

	it('is current for an unfaceted chart whatever its facet version says', () => {
		// _facetVersion is -1 on a chart that never had a facet scale, and must
		// not be read as a permanent mismatch.
		expect(frameUniformIsStale(settled({ facetScale: null, _facetVersion: -1 }), 7)).toBe(false);
	});

	it('is stale on a chart registered before its scales resolved', () => {
		// Registration seeds topology -1 and null ids precisely so the first
		// reconcile always fires, whether or not a mapping has arrived yet.
		const fresh = settled({
			xScaleId: null,
			yScaleId: null,
			_uniformTopology: -1,
			_uniformXScaleId: null,
			_uniformYScaleId: null
		});
		expect(frameUniformIsStale(fresh, 0)).toBe(true);
	});
});
