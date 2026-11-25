import { describe, it, expect } from 'vitest';
import { foldsBetweenUpdates, landingTracker } from './path-fold';

describe('foldsBetweenUpdates', () => {
	it('travels on a grid, of any size', () => {
		expect(foldsBetweenUpdates({ kind: 'grid', facets: 1, bins: 24, series: 5 })).toBe(true);
		expect(foldsBetweenUpdates({ kind: 'grid', facets: 3, bins: 8, series: 1 })).toBe(true);
	});

	it('replaces runs, and a refused layout', () => {
		expect(foldsBetweenUpdates({ kind: 'runs' })).toBe(false);
		expect(foldsBetweenUpdates({ kind: 'refused', why: 'not whole bins' })).toBe(false);
	});
});

describe('landingTracker', () => {
	it("lands the first write of a catch-up result's version, and only that one", () => {
		const lands = landingTracker();
		// An ordinary result: travels.
		expect(lands(1, 0)).toBe(false);
		// A catch-up result (landsFor is its version): its first write lands,
		// a second write of the same version travels.
		expect(lands(2, 2)).toBe(true);
		expect(lands(2, 2)).toBe(false);
		// The next ordinary result travels again.
		expect(lands(3, 0)).toBe(false);
		// A catch-up flag left over from an older version does not land a newer one.
		expect(lands(4, 2)).toBe(false);
	});

	it('is one per renderer', () => {
		const a = landingTracker();
		const b = landingTracker();
		expect(a(5, 5)).toBe(true);
		expect(b(5, 5)).toBe(true);
	});
});
