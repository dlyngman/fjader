import { describe, it, expect } from 'vitest';
import { frameUniformIsStale, type FrameUniformInputs } from './frame-uniform-sync';

/** An unfaceted chart whose uniform is up to date. */
function settled(over: Partial<FrameUniformInputs> = {}): FrameUniformInputs {
	return { facetScale: null, _facetVersion: -1, ...over };
}

describe('when a chart frame uniform has stopped describing its chart', () => {
	it('is current when nothing has moved', () => {
		expect(frameUniformIsStale(settled())).toBe(false);
	});

	it('notices a facet permutation moving under a cell', () => {
		const chart = settled({ facetScale: { _version: 4 }, _facetVersion: 3 });
		expect(frameUniformIsStale(chart)).toBe(true);

		chart._facetVersion = 4;
		expect(frameUniformIsStale(chart)).toBe(false);
	});

	it('is stale on a facet cell never written', () => {
		// Registration seeds _facetVersion at -1, which no facet scale reports,
		// so the first reconcile writes the id this cell shows.
		expect(frameUniformIsStale(settled({ facetScale: { _version: 0 } }))).toBe(true);
	});

	it('is current for an unfaceted chart whatever its facet version says', () => {
		// _facetVersion is -1 on a chart that never had a facet scale, and must
		// not be read as a permanent mismatch.
		expect(frameUniformIsStale(settled({ facetScale: null, _facetVersion: -1 }))).toBe(false);
	});
});
