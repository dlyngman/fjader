import { describe, it, expect } from 'vitest';
import {
	binExtent,
	binWindowFor,
	binWindowNeedsMove,
	insideBinWindow,
	viewInBinUnits
} from './bin-window';
import { intervalWidthMs } from '$lib/sql/bin';
import type { BinPadding } from '$lib/types';

describe('a viewport in the bins’ units', () => {
	it('time: seconds from the scale’s origin become epoch ms; numeric stays', () => {
		const t0 = Date.UTC(2024, 0, 1) / 1000;
		expect(viewInBinUnits([0, 86_400], t0)).toEqual([Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2)]);
		expect(viewInBinUnits([5, 9], null)).toEqual([5, 9]);
	});

	it('writes into the buffer it is given: a frame’s check allocates nothing', () => {
		const out: [number, number] = [0, 0];
		expect(viewInBinUnits([5, 9], null, out)).toBe(out);
		expect(out).toEqual([5, 9]);
	});
});

describe('a binned mark’s window', () => {
	it('is the viewport with 1.5 viewports of margin each side', () => {
		expect(binWindowFor([100, 200])).toEqual([-50, 350]);
	});

	it('stays while the viewport pans inside it, past half a viewport from either edge', () => {
		const w = binWindowFor([100, 200]);
		expect(binWindowNeedsMove(w, [100, 200], null)).toBe(false);
		expect(binWindowNeedsMove(w, [199, 299], null)).toBe(false);
		expect(binWindowNeedsMove(w, [1, 101], null)).toBe(false);
	});

	it('moves within half a viewport of an edge, either side', () => {
		const w = binWindowFor([100, 200]);
		expect(binWindowNeedsMove(w, [201, 301], null)).toBe(true);
		expect(binWindowNeedsMove(w, [-1, 99], null)).toBe(true);
	});

	it('a steady pan re-centres it about once per viewport travelled', () => {
		let w = binWindowFor([0, 100]);
		let moves = 0;
		for (let x = 0; x <= 1000; x += 1) {
			const view: [number, number] = [x, x + 100];
			if (binWindowNeedsMove(w, view, null)) {
				w = binWindowFor(view);
				moves++;
			}
		}
		// Just past one viewport each (the trigger is strict): 9 over 10 viewports.
		// A margin of 1 re-centred every half viewport: 2 per viewport.
		expect(moves / 10).toBeGreaterThan(0.85);
		expect(moves / 10).toBeLessThanOrEqual(1);
	});

	it('does not move toward an edge past the data’s end: nothing more to fetch', () => {
		const w = binWindowFor([100, 200]);
		expect(binWindowNeedsMove(w, [260, 360], [0, 300])).toBe(false);
		expect(binWindowNeedsMove(w, [260, 360], [0, 1000])).toBe(true);
		expect(binWindowNeedsMove(w, [-40, 60], [0, 1000])).toBe(false);
	});

	it('moves when the viewport outgrows its margin (a zoom out)', () => {
		expect(binWindowNeedsMove(binWindowFor([100, 200]), [0, 250], null)).toBe(true);
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

describe('a window snapped to the bin grid', () => {
	const num: BinPadding = { kind: 'number', source: 'x', min: 0, alpha: 30, count: 40, offset: 0 };
	const DAY = 86_400_000;
	const MIN = Date.UTC(2024, 0, 1);
	const days: BinPadding = {
		kind: 'time',
		source: 't',
		interval: 'INTERVAL 1 day',
		minMs: MIN,
		maxMs: MIN + 100 * DAY,
		t0: 0,
		count: 102,
		offset: 0
	};

	it('numeric: outward to whole bins', () => {
		// Unsnapped [-50, 350]: bins -2 .. 11.
		expect(binWindowFor([100, 200], num)).toEqual([-60, 360]);
	});

	it('time: outward to whole steps from the extent’s start', () => {
		const w = binWindowFor([MIN + 10.3 * DAY, MIN + 12.1 * DAY], days);
		expect(w).toEqual([MIN + 7 * DAY, MIN + 15 * DAY]);
	});

	it('two views over the same bins give the same window', () => {
		expect(binWindowFor([100, 200], num)).toEqual(binWindowFor([101, 201], num));
	});

	it('the nominal width of a SQL interval', () => {
		expect(intervalWidthMs('INTERVAL 6 hour')).toBe(6 * 3_600_000);
		expect(intervalWidthMs('INTERVAL 1 month')).toBe(30 * DAY);
		expect(intervalWidthMs('INTERVAL 2 days')).toBe(2 * DAY);
		expect(intervalWidthMs('not an interval')).toBeNull();
	});
});
