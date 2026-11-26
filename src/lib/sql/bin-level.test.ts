/**
 * View-scaled bins are resolved from the view's rebin level, not its width:
 * so they are a function of the view alone, the same for every mark on a field.
 */

import { describe, it, expect } from 'vitest';
import { bin, rebinLevel, REBIN_RATIO } from './bin';

const INFO = { v: { min: 0, max: 1000 } };
const T0 = Date.UTC(2024, 0, 1) / 1000;
const TIME_INFO = { t: { min: T0 * 1000, max: (T0 + 400 * 86_400) * 1000, type: 'date' } };

const numeric = (domain: [number, number] | null, multiplier = 1) =>
	bin('v').padding(INFO, 'linear', domain, multiplier);
const sqlOf = (domain: [number, number] | null) =>
	String(bin('v').resolve(INFO, 'linear', null, domain));

describe('rebinLevel', () => {
	it('is 0 for the whole extent, and one more for each ratio narrower', () => {
		expect(rebinLevel(1000, 1000)).toBe(0);
		expect(rebinLevel(1000 / REBIN_RATIO, 1000)).toBe(1);
		expect(rebinLevel(1000 / REBIN_RATIO ** 4, 1000)).toBe(4);
		expect(rebinLevel(1000 * REBIN_RATIO, 1000)).toBe(-1);
	});

	it('rounds to the nearest level, so a view a little off the extent is still level 0', () => {
		expect(rebinLevel(1040, 1000)).toBe(0);
		expect(rebinLevel(900, 1000)).toBe(0);
	});

	it('a view wider than the extent is a level less only at a whole ratio wider', () => {
		// A niced axis: a delay of -60..180 drawn on -100..200, a quarter wider.
		expect(rebinLevel(300, 240)).toBe(0);
		expect(rebinLevel(1490, 1000)).toBe(0);
		expect(rebinLevel(1510, 1000)).toBe(-1);
		expect(rebinLevel(2240, 1000)).toBe(-1);
		expect(rebinLevel(2260, 1000)).toBe(-2);
	});

	it('is 0 without a view or an extent', () => {
		expect(rebinLevel(0, 1000)).toBe(0);
		expect(rebinLevel(10, NaN)).toBe(0);
		expect(rebinLevel(NaN, 1000)).toBe(0);
	});
});

describe('bins resolved from the level', () => {
	it('do not change under a pan: the width is the same', () => {
		const here = numeric([100, 300]);
		expect(numeric([450, 650])).toEqual(here);
		expect(numeric([799.5, 999.5])).toEqual(here);
		expect(sqlOf([450, 650])).toBe(sqlOf([100, 300]));
	});

	it('are the same for every view of one level, wherever a mark looked from', () => {
		// Level 4 is a width of 1000 / 1.5^4 ≈ 197.5; its neighbours' boundaries
		// are at about 161 and 242.
		const level = rebinLevel(200, 1000);
		expect(rebinLevel(170, 1000)).toBe(level);
		expect(rebinLevel(235, 1000)).toBe(level);
		expect(numeric([0, 170])).toEqual(numeric([0, 200]));
		expect(numeric([600, 835])).toEqual(numeric([0, 200]));
	});

	it('come back the same after zooming in and out again', () => {
		const before = numeric([0, 400]);
		numeric([0, 20]);
		expect(numeric([10, 410])).toEqual(before);
	});

	it('refine as the view narrows, and never coarsen', () => {
		let last = Infinity;
		for (let width = 1000; width > 1; width /= 1.3) {
			const alpha = (numeric([0, width]) as { alpha: number }).alpha;
			expect(alpha).toBeLessThanOrEqual(last);
			last = alpha;
		}
		expect(last).toBeLessThan(1);
	});

	it('are the whole extent’s bins without a view, and at level 0', () => {
		expect(numeric([0, 1000])).toEqual(numeric(null));
		expect(numeric([-20, 1020])).toEqual(numeric(null));
	});

	it('are the whole extent’s bins on an axis niced a quarter past its data', () => {
		const info = { delay: { min: -60, max: 180 } };
		const at = (domain: [number, number] | null) =>
			bin('delay').padding(info, 'linear', domain) as { alpha: number };
		expect(at([-100, 200])).toEqual(at(null));
		expect(at(null).alpha).toBe(10);
		// Zoomed out for real, they coarsen.
		expect(at([-300, 420]).alpha).toBeGreaterThan(10);
	});

	it('follow the chart’s step multiplier at any level', () => {
		const one = numeric([0, 200]) as { alpha: number };
		const two = numeric([0, 200], 2) as { alpha: number };
		expect(two.alpha).toBeLessThan(one.alpha);
	});

	it('time bins: the same buckets for every view of one level, and under a pan', () => {
		const time = (domain: [number, number]) => bin('t').padding(TIME_INFO, 'time', domain, 1, T0);
		const day = 86_400;
		expect(time([40 * day, 80 * day])).toEqual(time([200 * day, 240 * day]));
		expect(time([0, 36 * day])).toEqual(time([0, 44 * day]));
	});
});

describe('a bin() that does not follow the view', () => {
	it('says so, and keeps its bins at any view', () => {
		expect(bin('v').followsView).toBe(true);
		expect(bin('v', { steps: 12 }).followsView).toBe(true);
		expect(bin('v', { step: 25 }).followsView).toBe(false);
		expect(bin('t', { interval: 'day' }).followsView).toBe(false);
		const fixed = (domain: [number, number] | null) =>
			bin('v', { step: 25 }).padding(INFO, 'linear', domain);
		expect(fixed([0, 10])).toEqual(fixed(null));
	});

	it('extentWidth is the field’s extent in the axis’s units: seconds on a time axis', () => {
		expect(bin('v').extentWidth(INFO, 'linear')).toBe(1000);
		expect(bin('t').extentWidth(TIME_INFO, 'time')).toBe(400 * 86_400);
		expect(bin('missing').extentWidth(INFO, 'linear')).toBeNaN();
	});
});

describe('a bound on the bins (a path mark, which must stay padded)', () => {
	const count = (domain: [number, number] | null, maxBins: number, multiplier = 1) =>
		(bin('v').padding(INFO, 'linear', domain, multiplier, null, maxBins) as { count: number })
			.count;

	it('holds view-scaled bins under the bound at any zoom', () => {
		for (let width = 1000; width > 0.5; width /= 1.4) {
			expect(count([0, width], 200)).toBeLessThanOrEqual(200);
		}
		// Unbounded, the same zoom passes it.
		expect(count([0, 1], Infinity)).toBeGreaterThan(200);
	});

	it('leaves the bins alone while they fit', () => {
		expect(bin('v').padding(INFO, 'linear', [0, 300], 1, null, 500)).toEqual(
			bin('v').padding(INFO, 'linear', [0, 300], 1)
		);
		expect(bin('v').held(INFO, 'linear', [0, 300], 1, 500)).toBeNull();
	});

	it('says when it holds, under zoom and under the step multiplier', () => {
		expect(bin('v').held(INFO, 'linear', [0, 2], 1, 200)).toBe('finest');
		expect(bin('v').held(INFO, 'linear', null, 1, 200)).toBeNull();
		expect(bin('v').held(INFO, 'linear', null, 40, 200)).toBe('finest');
		expect(count(null, 200, 40)).toBeLessThanOrEqual(200);
	});

	it('applies to the default bins too, when the bound is below them', () => {
		expect(count(null, Infinity)).toBeGreaterThan(10);
		expect(count(null, 10)).toBeLessThanOrEqual(10);
		expect(bin('v').held(INFO, 'linear', null, 1, 10)).toBe('finest');
	});

	it('gives the expression and its padding the same bins', () => {
		const node = bin('v');
		const pad = node.padding(INFO, 'linear', [0, 3], 1, null, 150) as { alpha: number };
		expect(String(node.resolve(INFO, 'linear', null, [0, 3], 1, 150))).toContain(
			`CAST(${JSON.stringify(pad.alpha)} AS DOUBLE)`
		);
	});

	it('does not touch a bin() with a step or an interval of its own', () => {
		const fixed = bin('v', { step: 1 });
		expect(fixed.padding(INFO, 'linear', null, 1, null, 50)).toEqual(
			fixed.padding(INFO, 'linear', null, 1)
		);
		expect(fixed.held(INFO, 'linear', null, 1, 50)).toBeNull();
	});

	it('holds time buckets under the bound as they are counted for padding', () => {
		const time = (domain: [number, number], maxBins: number) =>
			(bin('t').padding(TIME_INFO, 'time', domain, 1, T0, maxBins) as { count: number }).count;
		expect(time([0, 3600], Infinity)).toBeGreaterThan(300);
		expect(time([0, 3600], 300)).toBeLessThanOrEqual(300);
	});
});

describe('a floor on the steps (a path mark, which two points do not make)', () => {
	const count = (domain: [number, number] | null, multiplier: number, minSteps = 1) =>
		(
			bin('v').padding(INFO, 'linear', domain, multiplier, null, Infinity, minSteps) as {
				count: number;
			}
		).count;

	it('the step multiplier alone takes the bins down to a few', () => {
		expect(count(null, 0.1)).toBeLessThanOrEqual(4);
	});

	it('holds them at about the floor, at any zoom', () => {
		expect(count(null, 0.1, 8)).toBeGreaterThanOrEqual(5);
		// Zoomed in: the floor is across the view, so more across the extent.
		expect(count([0, 100], 0.1, 8)).toBeGreaterThan(count(null, 0.1, 8) * 4);
	});

	it('holds them for a view far wider than the data', () => {
		expect(count([-50_000, 50_000], 1)).toBeLessThanOrEqual(3);
		expect(count([-50_000, 50_000], 1, 8)).toBeGreaterThanOrEqual(5);
	});

	it('says so, leaves bins above it alone, and gives way to the upper bound', () => {
		const node = bin('v');
		expect(node.held(INFO, 'linear', null, 0.1, Infinity, 8)).toBe('coarsest');
		expect(node.held(INFO, 'linear', null, 1, Infinity, 8)).toBeNull();
		expect(node.padding(INFO, 'linear', null, 1, null, Infinity, 8)).toEqual(
			node.padding(INFO, 'linear', null, 1)
		);
		expect(node.held(INFO, 'linear', null, 0.1, 3, 8)).toBe('finest');
	});

	it('does not touch a bin() with a step of its own', () => {
		const fixed = bin('v', { step: 500 });
		expect(fixed.padding(INFO, 'linear', null, 1, null, Infinity, 8)).toEqual(
			fixed.padding(INFO, 'linear', null, 1)
		);
	});
});

describe('the steps across the view that view-following bins are resolved for', () => {
	it('are the mark’s steps by the step multiplier, 30 by default, with the floor', () => {
		expect(bin('v').viewSteps()).toBe(30);
		expect(bin('v', { steps: 60 }).viewSteps()).toBe(60);
		expect(bin('v', { steps: 60 }).viewSteps(0.5)).toBe(30);
		expect(bin('v').viewSteps(0.1, 8)).toBe(8);
	});

	it('are about the bins a view has at its own level, at every level', () => {
		// A view exactly on a level: 1000 / 1.5^k wide.
		for (let level = 0; level <= 8; level++) {
			const width = 1000 / REBIN_RATIO ** level;
			const pad = bin('v', { steps: 60 }).padding(INFO, 'linear', [0, width]) as { alpha: number };
			const inView = width / pad.alpha;
			expect(inView).toBeGreaterThan(60 / 2.6);
			expect(inView).toBeLessThanOrEqual(60 * 1.01);
		}
	});

	it('are null for bins that keep their step', () => {
		expect(bin('v', { step: 5 }).viewSteps()).toBeNull();
		expect(bin('t', { interval: 'day' }).viewSteps()).toBeNull();
	});
});
