import { describe, it, expect } from 'vitest';
import { binLayout } from './bin-layout';

/** Lower edges for F facets × the given bins × S rows per bin, in dense order. */
function edges(bins: number[], series: number, facets = 1): Float32Array {
	const out: number[] = [];
	for (let f = 0; f < facets; f++)
		for (const b of bins) for (let s = 0; s < series; s++) out.push(b);
	return Float32Array.from(out);
}

describe('binLayout', () => {
	it('reads one series as one row per bin', () => {
		const lower = edges([0, 10, 20, 30], 1);
		expect(binLayout(lower, lower.length)).toEqual({ series: 1, bins: 4, facets: 1 });
	});

	it('reads S rows per bin', () => {
		const lower = edges([0, 10, 20], 4);
		expect(binLayout(lower, lower.length)).toEqual({ series: 4, bins: 3, facets: 1 });
	});

	it('reads facets as repeats of the same bins', () => {
		const lower = edges([0, 10, 20], 3, 2);
		expect(binLayout(lower, lower.length)).toEqual({ series: 3, bins: 3, facets: 2 });
	});

	it('takes a single bin', () => {
		expect(binLayout(edges([5], 3), 3)).toEqual({ series: 3, bins: 1, facets: 1 });
	});

	it('is null for no rows, or fewer edges than rows', () => {
		expect(binLayout(new Float32Array(0), 0)).toBeNull();
		expect(binLayout(edges([0, 10], 1), 3)).toBeNull();
	});

	it('is null when a bin has a row too few', () => {
		const lower = Float32Array.from([0, 0, 0, 10, 10, 20, 20, 20]);
		expect(binLayout(lower, lower.length)).toBeNull();
	});

	it('is null when a bin has a row too many', () => {
		const lower = Float32Array.from([0, 0, 10, 10, 10, 20, 20, 20, 30]);
		expect(binLayout(lower, lower.length)).toBeNull();
	});

	it('is null when the bins are not ascending', () => {
		const lower = Float32Array.from([0, 20, 10, 30]);
		// The descent reads as a second facet, whose bins are not the first's.
		expect(binLayout(lower, lower.length)).toBeNull();
	});

	it('is null when a facet has other bins than the first', () => {
		const lower = Float32Array.from([0, 0, 10, 10, 0, 0, 15, 15]);
		expect(binLayout(lower, lower.length)).toBeNull();
	});

	it('is null when an edge is NaN', () => {
		expect(binLayout(Float32Array.from([NaN, NaN]), 2)).toBeNull();
		expect(binLayout(Float32Array.from([0, 0, NaN, NaN]), 4)).toBeNull();
	});
});
