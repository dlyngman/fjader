import { describe, it, expect } from 'vitest';
import {
	binExtent,
	binWindowFor,
	binWindowNeedsMove,
	insideBinWindow,
	MARGIN,
	viewInBinUnits,
	windowCoversExtent,
	windowPaddedBins
} from './bin-window';
import { AutoBinNode, bin, intervalWidthMs, REBIN_RATIO } from '$lib/sql/bin';
import { windowBinCount } from '$lib/transforms';
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

describe('a path’s bin cap over a window (windowPaddedBins)', () => {
	// The padding's row limit over one bin's rows: ten series (10 + 1), forty
	// facets of ten series, and a few in between.
	const caps = Array.from({ length: 140 }, (_, i) => 20 + i * 7);
	const levels = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15];
	// Positions within a level (0: its widest view, 1: its narrowest) and
	// across the extent (0: the start, 1: the end).
	const within = [0.001, 0.25, 0.5, 0.75, 0.999];
	const across = [0, 0.13, 0.3, 0.5, 0.71, 0.97, 1];

	/** The views of rebin level `level` on an extent `width` wide, its widest first. */
	function levelWidths(width: number, level: number): number[] {
		return within.map((f) => width / REBIN_RATIO ** (level - 0.5 + f));
	}

	function check(
		node: AutoBinNode,
		fieldInfo: Record<string, { min: number; max: number; type?: string }>,
		scaleType: string,
		lo: number,
		width: number,
		t0: number | null
	) {
		for (const cap of caps) {
			for (const level of levels) {
				for (const w of levelWidths(width, level)) {
					// The bins are planned at one view of the level (the rebin's)...
					const at: [number, number] = [lo + (width - w) / 2, lo + (width + w) / 2];
					const bins = node.padding(fieldInfo, scaleType, at, 1, t0, cap, 8, windowPaddedBins);
					expect(bins).not.toBeNull();
					// ...and padded over a window placed at any view of the level.
					for (const other of levelWidths(width, level)) {
						for (const f of across) {
							const start = lo + f * (width - other);
							const view = viewInBinUnits([start, start + other], t0);
							const count = windowBinCount(bins!, binWindowFor(view, bins!));
							expect(count, `cap ${cap}, level ${level}`).toBeLessThanOrEqual(cap);
						}
					}
				}
			}
		}
	}

	it('numeric bins: a window at the cap never passes the row limit', () => {
		const node = bin('v');
		check(node, { v: { min: -37.5, max: 912.25 } }, 'linear', -37.5, 949.75, null);
	});

	it('time bins: a window at the cap never passes the row limit', () => {
		const min = Date.UTC(2019, 0, 1);
		const max = Date.UTC(2024, 6, 1);
		const t0 = min / 1000;
		const node = bin('t');
		// Views are seconds from the scale's origin, as a time axis draws them.
		check(node, { t: { min, max, type: 'date' } }, 'time', 0, (max - min) / 1000, t0);
	});

	it('whole extent: the window is clipped to it, so no more than its bins', () => {
		expect(windowPaddedBins(500, 0, false)).toBe(500);
		expect(windowPaddedBins(500, -2, true)).toBe(500);
		expect(windowPaddedBins(500, 2, false)).toBe(500);
	});

	it('deep in: about (1 + 2·MARGIN) views of bins, plus the snapped ends', () => {
		const share = (1 + 2 * MARGIN) * REBIN_RATIO ** (0.5 - 10);
		expect(windowPaddedBins(10_000, 10, false)).toBe(Math.ceil(10_000 * share) + 3);
	});
});

describe('whether a path needs a window yet (windowCoversExtent)', () => {
	const numeric: BinPadding = {
		kind: 'number',
		source: 'v',
		min: 0,
		alpha: 10,
		count: 100,
		offset: 0
	};
	it('not while the window would hold the whole extent', () => {
		expect(windowCoversExtent([0, 1000], numeric)).toBe(true);
		// A quarter of the extent: 1.5 views each side reach both ends.
		expect(windowCoversExtent([375, 625], numeric)).toBe(true);
	});
	it('once the window would leave part of it out', () => {
		expect(windowCoversExtent([0, 250], numeric)).toBe(false);
		expect(windowCoversExtent([400, 500], numeric)).toBe(false);
	});
});
