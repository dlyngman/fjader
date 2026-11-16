import { describe, it, expect } from 'vitest';
import {
	binExtent,
	binWindowFor,
	binWindowNeedsMove,
	insideBinWindow,
	viewInBinUnits
} from './bin-window';

describe('a viewport in the bins’ units', () => {
	it('time: seconds from the scale’s origin become epoch ms; numeric stays', () => {
		const t0 = Date.UTC(2024, 0, 1) / 1000;
		expect(viewInBinUnits([0, 86_400], t0)).toEqual([Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2)]);
		expect(viewInBinUnits([5, 9], null)).toEqual([5, 9]);
	});
});

describe('a binned mark’s window', () => {
	it('is the viewport with a viewport of margin each side', () => {
		expect(binWindowFor([100, 200])).toEqual([0, 300]);
	});

	it('stays while the viewport pans inside it, past half a viewport from either edge', () => {
		const w = binWindowFor([100, 200]);
		expect(binWindowNeedsMove(w, [100, 200], null)).toBe(false);
		expect(binWindowNeedsMove(w, [149, 249], null)).toBe(false);
		expect(binWindowNeedsMove(w, [51, 151], null)).toBe(false);
	});

	it('moves within half a viewport of an edge, either side', () => {
		const w = binWindowFor([100, 200]);
		expect(binWindowNeedsMove(w, [151, 251], null)).toBe(true);
		expect(binWindowNeedsMove(w, [49, 149], null)).toBe(true);
	});

	it('does not move toward an edge past the data’s end: nothing more to fetch', () => {
		const w = binWindowFor([100, 200]);
		expect(binWindowNeedsMove(w, [180, 280], [0, 250])).toBe(false);
		expect(binWindowNeedsMove(w, [180, 280], [0, 1000])).toBe(true);
		expect(binWindowNeedsMove(w, [20, 120], [50, 1000])).toBe(false);
	});

	it('moves when the viewport outgrows its margin (a zoom out)', () => {
		expect(binWindowNeedsMove(binWindowFor([100, 200]), [40, 260], null)).toBe(true);
	});

	it('none is the whole extent, which serves any viewport: it takes one at a rebin', () => {
		expect(binWindowNeedsMove(null, [100, 200], null)).toBe(false);
	});

	it('a zoom in keeps it: more margin, the same bins', () => {
		expect(binWindowNeedsMove(binWindowFor([100, 200]), [130, 170], null)).toBe(false);
	});

	it('tells whether a range is inside it; none is the whole extent', () => {
		expect(insideBinWindow([0, 300], [10, 290])).toBe(true);
		expect(insideBinWindow([0, 300], [10, 310])).toBe(false);
		expect(insideBinWindow(null, [-1e9, 1e9])).toBe(true);
	});

	it('reads a bin spec’s extent in its own units', () => {
		expect(
			binExtent({ kind: 'number', source: 'x', min: 10, alpha: 5, count: 4, offset: 0 })
		).toEqual([10, 30]);
		expect(
			binExtent({
				kind: 'time',
				source: 't',
				interval: 'INTERVAL 1 day',
				minMs: 1,
				maxMs: 9,
				t0: 0,
				count: 1,
				offset: 0
			})
		).toEqual([1, 9]);
	});
});
