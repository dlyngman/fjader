import { describe, it, expect } from 'vitest';
import {
	buildBinCut,
	buildBinRemap,
	cutRows,
	hasSeams,
	isNested,
	parentsFromMap,
	siblingSeams,
	NEST_EPSILON,
	type BinRemapSide
} from './bin-remap';
import { gatherReference, remapReference } from './RemapShader';
import { binLayout } from '$lib/components/marks/lifecycle/bin-layout';

/** A dense side: `edges` are the bins' bounds, each bin repeated per series and facet. */
function side(edges: number[], series = 1, facets = 1, ids?: number[][]): BinRemapSide {
	const lower: number[] = [];
	const upper: number[] = [];
	for (let f = 0; f < facets; f++) {
		for (let b = 0; b + 1 < edges.length; b++) {
			for (let s = 0; s < series; s++) {
				lower.push(edges[b]);
				upper.push(edges[b + 1]);
			}
		}
	}
	const lo = Float32Array.from(lower);
	const layout = binLayout(lo, lo.length)!;
	// Default ids: the series index in every run, the facet index per facet.
	const seriesIds = Float32Array.from(lo, (_, j) => j % series);
	const facetIds = Float32Array.from(lo, (_, j) => Math.floor(j / ((edges.length - 1) * series)));
	return {
		lower: lo,
		upper: Float32Array.from(upper),
		layout,
		ids: ids?.map((c) => Float32Array.from(c)) ?? [seriesIds, facetIds]
	};
}

const linear = (min: number, max: number) => [min, max, 1 / (max - min), 0];
const SAME = linear(0, 100);

/** The new rows' starting values, no scale change. */
function remap(prev: BinRemapSide, next: BinRemapSide, old: number[], to: number[]): number[] {
	const map = buildBinRemap(prev, next)!;
	const out = new Float32Array(to.length);
	return Array.from(remapReference('linear', old, to, map, SAME, SAME, to.length, out));
}

describe('the bins remap', () => {
	it('starts a split’s children at their parent’s value', () => {
		const from = remap(side([0, 10, 20]), side([0, 5, 10, 15, 20]), [8, 4], [3, 5, 1, 3]);
		expect(from).toEqual([8, 8, 4, 4]);
	});

	it('starts a merge at its children’s mean', () => {
		const from = remap(side([0, 5, 10, 15, 20]), side([0, 10, 20]), [2, 6, 1, 3], [8, 4]);
		expect(from).toEqual([4, 2]);
	});

	it('blends the months a week spans, by overlap', () => {
		// Months of 31 and 28 days; a week from day 28 to 35 spans both.
		const from = remap(side([0, 31, 59]), side([28, 35]), [7, 14], [0]);
		expect(from[0]).toBeCloseTo((3 / 7) * 7 + (4 / 7) * 14, 5);
	});

	it('starts the part of a new bin no old bin covers at its own value', () => {
		// The new extent reaches 10 past the old one's end.
		const from = remap(side([0, 10]), side([0, 10, 20]), [6], [5, 9]);
		expect(from).toEqual([6, 9]);
		const half = remap(side([0, 10]), side([0, 20]), [6], [8]);
		expect(half[0]).toBeCloseTo(0.5 * 6 + 0.5 * 8, 5);
	});

	it('maps a shifted window (same step) one-to-one; bins entering at the edge land', () => {
		// A pan past a padded window: bins 0..50 → 20..70, step 10.
		const prev = side([0, 10, 20, 30, 40, 50]);
		const next = side([20, 30, 40, 50, 60, 70]);
		const map = buildBinRemap(prev, next)!;
		expect(map).not.toBeNull();
		const from = remap(prev, next, [1, 2, 3, 4, 5], [9, 9, 9, 7, 8]);
		expect(from).toEqual([3, 4, 5, 7, 8]);
		// And the other way, entering at the left.
		expect(remap(next, prev, [3, 4, 5, 7, 8], [6, 6, 1, 2, 3])).toEqual([6, 6, 3, 4, 5]);
	});

	it('maps a shifted window across series and facets, on a time-like grid', () => {
		// Hours as seconds from t0, 3 series, 2 facets: rows stay with their own.
		const h = (k: number) => k * 3600;
		const edges = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => h(a + i));
		const prev = side(edges(100, 104), 3, 2);
		const next = side(edges(102, 106), 3, 2);
		const old = Array.from({ length: 4 * 3 * 2 }, (_, j) => j);
		const to = Array.from({ length: 4 * 3 * 2 }, () => -1);
		const from = remap(prev, next, old, to);
		// Per facet, new bins 0..1 are old bins 2..3 (same series); 2..3 enter (own value).
		for (let f = 0; f < 2; f++) {
			for (let b = 0; b < 4; b++) {
				for (let s = 0; s < 3; s++) {
					const j = f * 12 + b * 3 + s;
					expect(from[j]).toBe(b < 2 ? f * 12 + (b + 2) * 3 + s : -1);
				}
			}
		}
	});

	it('keeps each row to its own series and facet', () => {
		// Two series, two facets; old values encode facet, bin and series.
		const prev = side([0, 10, 20], 2, 2);
		const next = side([0, 5, 10, 15, 20], 2, 2);
		const old = [0, 1, 10, 11, 100, 101, 110, 111]; // f*100 + b*10 + s
		const from = remap(prev, next, old, new Array(16).fill(0));
		expect(from).toEqual([0, 1, 0, 1, 10, 11, 10, 11, 100, 101, 100, 101, 110, 111, 110, 111]);
	});

	it('refuses rows that do not correspond: another series set or order, other facets', () => {
		expect(buildBinRemap(side([0, 10]), side([0, 5, 10], 2))).toBeNull();
		expect(buildBinRemap(side([0, 10], 1, 1), side([0, 5, 10], 1, 2))).toBeNull();
		const prev = side([0, 10], 2, 1, [[3, 7]]);
		const swapped = side([0, 5, 10], 2, 1, [[7, 3, 7, 3]]);
		expect(buildBinRemap(prev, swapped)).toBeNull();
	});

	it('keeps the old rows in the units they were drawn in, whatever the domain is now', () => {
		// The pixel-space resolve carries them from there (fromParams = drawn).
		const map = buildBinRemap(side([0, 10, 20]), side([0, 5, 10, 15, 20]))!;
		const out = new Float32Array(4);
		remapReference('linear', [80, 40], [0, 0, 0, 0], map, linear(0, 100), linear(0, 50), 4, out);
		expect(Array.from(out)).toEqual([80, 80, 40, 40]);
	});

	it('re-expresses the uncovered part’s own value in the old units', () => {
		// A new bin half past the old extent: half its start is the old row, half
		// its new value, which under [0, 50] is the pixel 2× that value has under
		// [0, 100].
		const map = buildBinRemap(side([0, 10]), side([0, 20]))!;
		const out = new Float32Array(1);
		remapReference('linear', [60], [10], map, linear(0, 100), linear(0, 50), 1, out);
		expect(out[0]).toBeCloseTo(0.5 * 60 + 0.5 * 20, 4);
	});

	it('leaves a binding on no scale untransformed (an Other share)', () => {
		const map = buildBinRemap(side([0, 10]), side([0, 5, 10]))!;
		const out = new Float32Array(2);
		remapReference('none', [0.25], [0, 0], map, linear(0, 100), linear(0, 50), 2, out);
		expect(Array.from(out)).toEqual([0.25, 0.25]);
	});

	it('makes a row NaN when an old value is, so the resolve lands it', () => {
		const map = buildBinRemap(side([0, 10]), side([0, 5, 10]))!;
		const out = new Float32Array(2);
		remapReference('linear', [NaN], [1, 2], map, SAME, SAME, 2, out);
		expect(Number.isNaN(out[0])).toBe(true);
	});
});

/** As `remap`, for rows that sit at a point in their bin (a line's vertices). */
function remapPoints(
	prev: BinRemapSide,
	next: BinRemapSide,
	old: number[],
	to: number[]
): number[] {
	const map = buildBinRemap(prev, next, 0, 'point')!;
	const out = new Float32Array(to.length);
	return Array.from(remapReference('linear', old, to, map, SAME, SAME, to.length, out));
}

describe('the bins remap for points (lines, areas)', () => {
	it('starts a split’s points on the old path: interpolated between the old points around them', () => {
		// Old points at 5, 15 and 25; new ones at 2.5, 7.5, …, 27.5.
		const from = remapPoints(
			side([0, 10, 20, 30]),
			side([0, 5, 10, 15, 20, 25, 30]),
			[0, 10, 20],
			[9, 9, 9, 9, 9, 9]
		);
		// Before the first old point and after the last: that end point's value.
		expect(from).toEqual([0, 2.5, 7.5, 12.5, 17.5, 20]);
	});

	it('a split that does not nest (5 to 2) interpolates by the centres all the same', () => {
		const from = remapPoints(side([0, 5, 10]), side([0, 2, 4, 6, 8, 10]), [0, 10], [9, 9, 9, 9, 9]);
		// Centres 1, 3, 5, 7, 9 against old points at 2.5 and 7.5.
		expect(from).toEqual([0, 1, 5, 9, 10]);
	});

	it('samples the old path on a merge too, so a peak is not averaged away', () => {
		// Old points at 0.5, 1.5, 2.5 with a peak in the middle; one new point at 1.5.
		const peak = remapPoints(side([0, 1, 2, 3]), side([0, 3]), [0, 10, 0], [9]);
		// The mean of what it covers would start it at 3.33 and climb back.
		expect(peak).toEqual([10]);
		// 2 into 5: old centres 1, 3, 5, 7, 9; new ones at 2.5 and 7.5.
		const from = remapPoints(side([0, 2, 4, 6, 8, 10]), side([0, 5, 10]), [1, 2, 3, 4, 5], [9, 9]);
		expect(from[0]).toBeCloseTo(1.75);
		expect(from[1]).toBeCloseTo(4.25);
	});

	it('maps the same bins over a moved window one to one', () => {
		const from = remapPoints(
			side([0, 1, 2, 3, 4]),
			side([1, 2, 3, 4, 5]),
			[7, 8, 9, 10],
			[0, 0, 0, 6]
		);
		// The point past the old rows has nothing to start from: it starts at its new value.
		expect(from).toEqual([8, 9, 10, 6]);
	});

	it('a new point outside the old rows starts at its new value: it appears at once', () => {
		const from = remapPoints(
			side([10, 20, 30]),
			side([0, 5, 10, 15, 20, 25, 30, 35, 40]),
			[4, 8],
			[1, 1, 9, 9, 9, 9, 3, 3]
		);
		expect(from.slice(0, 2)).toEqual([1, 1]);
		expect(from.slice(6)).toEqual([3, 3]);
	});

	it('a gap next to a new point makes its start NaN, so it lands rather than averaging the gap away', () => {
		const from = remapPoints(
			side([0, 10, 20, 30]),
			side([0, 5, 10, 15, 20, 25, 30]),
			[0, NaN, 20],
			[9, 9, 9, 9, 9, 9]
		);
		expect(from[0]).toBe(0);
		expect(Number.isNaN(from[1]) && Number.isNaN(from[2]) && Number.isNaN(from[3])).toBe(true);
	});
});

/** A held side's rows gathered from a new side's (the hold's `to`), from `to` as it was. */
function gather(held: BinRemapSide, next: BinRemapSide, src: number[], to: number[]): number[] {
	const map = buildBinRemap(next, held, NEST_EPSILON)!;
	return Array.from(gatherReference(src, Float32Array.from(to), map, to.length));
}

describe('a merge that holds: nesting and the gather', () => {
	const nested = (held: BinRemapSide, next: BinRemapSide) =>
		isNested(buildBinRemap(next, held, NEST_EPSILON)!);

	it('tells nested merges from the rest', () => {
		// Pairs of children into parents: nested.
		expect(nested(side([0, 5, 10, 15, 20]), side([0, 10, 20]))).toBe(true);
		// Weeks into months: the week from 28 to 35 straddles two.
		expect(nested(side([0, 7, 14, 21, 28, 35]), side([0, 31, 59]))).toBe(false);
		// A split: each held bin covers two new ones.
		expect(nested(side([0, 10, 20]), side([0, 5, 10, 15, 20]))).toBe(false);
		// Nothing in common: no held bin has a parent.
		expect(nested(side([0, 10]), side([20, 40]))).toBe(false);
	});

	it('tolerates edges one Float32 rounding apart', () => {
		// Time offsets near 6e7 s have about 4 s of resolution: a parent's edge
		// can land a few seconds into its neighbour's child.
		const t = 6e7;
		const day = 86400;
		const fine = side([t, t + day / 2, t + day, t + (3 * day) / 2, t + 2 * day]);
		const coarse = side([t, t + day + 4, t + 2 * day]);
		expect(nested(fine, coarse)).toBe(true);
		// Without the tolerance the sliver makes it straddle.
		expect(isNested(buildBinRemap(coarse, fine)!)).toBe(false);
	});

	it('gives each held row its parent’s value, per series and facet', () => {
		const held = side([0, 5, 10, 15, 20], 2, 2);
		const next = side([0, 10, 20], 2, 2);
		// New rows: facet, bin, series.
		const src = [10, 20, 30, 40, 50, 60, 70, 80];
		const to = gather(held, next, src, new Array(16).fill(0));
		expect(to).toEqual([10, 20, 10, 20, 30, 40, 30, 40, 50, 60, 50, 60, 70, 80, 70, 80]);
	});

	it('keeps the value of a held bin with no parent (the window’s margin)', () => {
		// The new window starts at 10: held bins below it are off screen.
		const to = gather(side([0, 5, 10, 15, 20]), side([10, 20]), [9], [1, 2, 3, 4]);
		expect(to).toEqual([1, 2, 9, 9]);
	});

	it('swaps invisibly: the forward map starts each parent where its children ended', () => {
		// Children gathered to their parents' values, then the new layout goes
		// up through the forward map from the held rows: nothing moves.
		const held = side([0, 5, 10, 15, 20]);
		const next = side([0, 10, 20]);
		const landed = gather(held, next, [8, 4], [2, 6, 1, 3]);
		expect(remap(held, next, landed, [8, 4])).toEqual([8, 4]);
	});
});

describe('a rebin’s points start on the drawn curve, not its chord', () => {
	const MONOTONE = { curve: 'monotone-x', swap: false } as const;
	const sampleOn = (
		curve: { curve: 'monotone-x' | 'monotone-y'; swap: boolean } | null,
		prev: BinRemapSide,
		next: BinRemapSide,
		old: number[]
	) => {
		const map = buildBinRemap(prev, next, 0, 'point')!;
		const to = new Array(next.lower.length).fill(9);
		const out = new Float32Array(to.length);
		return Array.from(remapReference('linear', old, to, map, SAME, SAME, to.length, out, curve));
	};

	it('samples the monotone curve through the old points', () => {
		// Old points at 5, 15, 25, 35; the new point at 7.5 is a quarter of the way to 15.
		const from = sampleOn(
			MONOTONE,
			side([0, 10, 20, 30, 40]),
			side([0, 5, 10, 15, 20, 25, 30, 35, 40]),
			[0, 10, 0, 10]
		);
		// Hermite at t = 0.25 with tangents 1 (one-sided at the series' start) and 0 (the
		// peak at 15): 0.140625 · 10 + 0.15625 · 10. The chord gives 2.5.
		expect(from[1]).toBeCloseTo(2.96875, 5);
		expect(
			sampleOn(
				null,
				side([0, 10, 20, 30, 40]),
				side([0, 5, 10, 15, 20, 25, 30, 35, 40]),
				[0, 10, 0, 10]
			)[1]
		).toBeCloseTo(2.5, 5);
	});

	it('does not overshoot at a peak, as the drawn monotone curve does not', () => {
		const from = sampleOn(
			MONOTONE,
			side([0, 10, 20, 30, 40]),
			side([0, 5, 10, 15, 20, 25, 30, 35, 40]),
			[0, 10, 0, 10]
		);
		for (const v of from) expect(v).toBeLessThanOrEqual(10);
	});

	it('a held point moves onto the new curve the same way', () => {
		const held = side([0, 5, 10, 15, 20, 25, 30, 35, 40]);
		const next = side([0, 10, 20, 30, 40]);
		const map = buildBinRemap(next, held, 0, 'point')!;
		const out = gatherReference(
			[0, 10, 0, 10],
			Float32Array.from(new Array(8).fill(1)),
			map,
			8,
			MONOTONE
		);
		expect(out[1]).toBeCloseTo(2.96875, 5);
	});

	it('a gap among the four points makes the start NaN, as the drawn segment breaks', () => {
		const from = sampleOn(
			MONOTONE,
			side([0, 10, 20, 30, 40]),
			side([0, 5, 10, 15, 20, 25, 30, 35, 40]),
			[0, 10, NaN, 10]
		);
		// 12.5 sits between 5 and 15, with 25 (the gap) as the point after next.
		expect(Number.isNaN(from[2])).toBe(true);
	});
});

describe('a merge that holds, for points (lines, areas)', () => {
	it('moves each held point onto the new, coarser path at its own position', () => {
		// Held points at 2.5, 7.5, 12.5, 17.5; the new ones at 5 and 15, worth 4 and 8.
		const held = side([0, 5, 10, 15, 20]);
		const next = side([0, 10, 20]);
		const map = buildBinRemap(next, held, 0, 'point')!;
		const out = gatherReference([4, 8], Float32Array.from([1, 1, 1, 1]), map, 4);
		// Past the first new point and the last: that end point's value.
		expect(Array.from(out)).toEqual([4, 5, 7, 8]);
	});

	it('needs no nesting: 2 into 5 holds the same way', () => {
		const held = side([0, 2, 4, 6, 8, 10]);
		const next = side([0, 5, 10]);
		const map = buildBinRemap(next, held, 0, 'point')!;
		const out = gatherReference([0, 10], Float32Array.from([1, 1, 1, 1, 1]), map, 5);
		// Held centres 1, 3, 5, 7, 9 against new points at 2.5 and 7.5.
		expect(Array.from(out)).toEqual([0, 1, 5, 9, 10]);
	});
});

describe('a merge that does not nest: the cut', () => {
	// Step 2 into step 5: the new edge at 5 falls inside the held bar 4–6.
	const held = side([0, 2, 4, 6, 8, 10]);
	const next = side([0, 5, 10]);

	it('cuts the held bars at the new edges, and only there', () => {
		const cut = buildBinCut(held, next)!;
		expect(Array.from(cut.side.lower)).toEqual([0, 2, 4, 5, 6, 8]);
		expect(Array.from(cut.side.upper)).toEqual([2, 4, 5, 6, 8, 10]);
		expect(cut.side.layout).toEqual({ series: 1, bins: 6, facets: 1 });
		// The cut at 5 is flush (2: upper of 4–5, 1: lower of 5–6); every other
		// shared edge is between pieces of one new bar: siblings (8 upper, 4 lower).
		expect(Array.from(cut.seams)).toEqual([8, 12, 6, 9, 12, 4]);
	});

	it('looks like the held bars at the start, and like the new bars at the end', () => {
		const cut = buildBinCut(held, next)!;
		const heldValues = [1, 2, 3, 4, 5];
		const start = remapReference(
			'linear',
			heldValues,
			new Float32Array(6),
			cut.fromHeld,
			SAME,
			SAME,
			6,
			new Float32Array(6)
		);
		// The bar 4–6 is two pieces at its own height.
		expect(Array.from(start)).toEqual([1, 2, 3, 3, 4, 5]);
		const end = gatherReference([20, 30], new Float32Array(6), cut.fromNew, 6);
		expect(Array.from(end)).toEqual([20, 20, 20, 30, 30, 30]);
	});

	it('swaps invisibly at the end: the forward map from the pieces lands on the new values', () => {
		const cut = buildBinCut(held, next)!;
		const landed = Array.from(gatherReference([20, 30], new Float32Array(6), cut.fromNew, 6));
		// Width-weighted: pieces of one new bin are all at its value.
		const map = buildBinRemap(cut.side, next)!;
		const out = remapReference('linear', landed, [20, 30], map, SAME, SAME, 2, new Float32Array(2));
		expect(Array.from(out)).toEqual([20, 30]);
	});

	it('cuts weeks into months', () => {
		// Weeks of 7 days from day 0; months of 31 and 28 days.
		const weeks = side([0, 7, 14, 21, 28, 35, 42, 49, 56]);
		const months = side([0, 31, 59]);
		const cut = buildBinCut(weeks, months)!;
		expect(Array.from(cut.side.lower)).toEqual([0, 7, 14, 21, 28, 31, 35, 42, 49]);
		expect(isNested(buildBinRemap(months, cut.side, NEST_EPSILON)!)).toBe(true);
	});

	it('copies each held row’s run per series and facet; ids follow', () => {
		const h = side([0, 2, 4], 2, 2);
		const n = side([0, 3, 4], 2, 2);
		const cut = buildBinCut(h, n)!;
		// Pieces: [0,2], [2,3], [3,4]; rows facet, piece, series.
		const rows = cutRows(Float32Array.from([10, 11, 12, 13, 20, 21, 22, 23]), cut)!;
		expect(Array.from(new Float32Array(rows.buffer))).toEqual([
			10, 11, 12, 13, 12, 13, 20, 21, 22, 23, 22, 23
		]);
		expect(Array.from(cut.side.ids[0])).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
		expect(Array.from(cut.side.ids[1])).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
		// Not in the held layout: not cut.
		expect(cutRows(new Float32Array(3), cut)).toBeNull();
	});

	it('cuts nothing, and returns null, when the new edges are the held ones within ε', () => {
		const t = 6e7;
		const day = 86400;
		const fine = side([t, t + day / 2, t + day, t + (3 * day) / 2, t + 2 * day]);
		expect(buildBinCut(fine, side([t, t + day + 4, t + 2 * day]))).toBeNull();
	});
});

describe('sibling seams', () => {
	it('flags the edges a split’s children share with a sibling, not their parent’s own', () => {
		const map = buildBinRemap(side([0, 10, 20]), side([0, 5, 10, 15, 20]))!;
		const seams = siblingSeams(parentsFromMap(map), 1, 1);
		expect(Array.from(seams)).toEqual([8, 4, 8, 4]);
	});

	it('flags a hold’s siblings under one parent; a held bin with none has none', () => {
		const map = buildBinRemap(side([10, 20]), side([0, 5, 10, 15, 20]), NEST_EPSILON)!;
		expect(Array.from(parentsFromMap(map))).toEqual([-1, -1, 0, 0]);
		expect(Array.from(siblingSeams(parentsFromMap(map), 1, 1))).toEqual([0, 0, 8, 4]);
	});

	it('repeats per series and facet', () => {
		const map = buildBinRemap(side([0, 10, 20], 2, 2), side([0, 5, 10, 15, 20], 2, 2))!;
		const facet = [8, 8, 4, 4, 8, 8, 4, 4];
		expect(Array.from(siblingSeams(parentsFromMap(map), 2, 2))).toEqual([...facet, ...facet]);
	});

	it('finds none where no two neighbours share a parent', () => {
		const map = buildBinRemap(side([0, 10, 20]), side([0, 10, 20]))!;
		expect(hasSeams(siblingSeams(parentsFromMap(map), 1, 1))).toBe(false);
	});
});
