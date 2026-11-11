import { describe, it, expect } from 'vitest';
import { avg, count, max, sql, sum, column } from '@uwdata/mosaic-sql';
import { otherSplit, splittable } from './other-split';

const col = (values: unknown[]) => ({ at: (row: number) => values[row] });

/** a b c d NULL as ids 0..4, Other is 9. */
const decode = ['a', 'b', 'c', 'd', null];

function split(selected: Set<unknown> | null, rows = defaultRows) {
	return Array.from(
		otherSplit({
			rows: rows.band.length,
			band: col(rows.band),
			otherId: 9,
			ids: col(rows.ids),
			values: col(rows.values),
			selected,
			decode
		})
	);
}

// Two shown rows (ids 0, 1), then Other holding c (30), d (10) and NULL (60).
const defaultRows = {
	band: [0, 1, 9],
	ids: [null, null, Int32Array.from([2, 3, 4])],
	values: [null, null, Float64Array.from([30, 10, 60])]
};

describe('otherSplit', () => {
	it('is 0 on every row that is not an Other, and 1 + share on one', () => {
		const [a, b, other] = split(new Set(['c']));
		expect([a, b]).toEqual([0, 0]);
		expect(other).toBeCloseTo(1.3, 6);
	});

	it('weights members by their measure, and counts NULL by its value', () => {
		expect(split(new Set(['c', null]))[2]).toBeCloseTo(1.9, 6);
	});

	it('is the whole bar (share 1) with nothing selected, and none of it with no member selected', () => {
		expect(split(null)[2]).toBe(2);
		expect(split(new Set(['a']))[2]).toBe(1);
	});

	it('splits each Other row by its own members (series, facet cells)', () => {
		const rows = {
			band: [9, 9],
			ids: [Int32Array.from([2]), Int32Array.from([3])],
			values: [Float64Array.from([5]), Float64Array.from([5])]
		};
		expect(split(new Set(['c']), rows)).toEqual([2, 1]);
	});

	it('gives no split to members of mixed signs', () => {
		const rows = {
			band: [9],
			ids: [Int32Array.from([2, 3])],
			values: [Float64Array.from([10, -4])]
		};
		expect(split(new Set(['c']), rows)).toEqual([0]);
	});
});

describe('splittable', () => {
	it('splits a bar whose length is a bare count or sum, or a raw column', () => {
		expect(splittable('y2', null, count())).toBe(true);
		expect(splittable('y2', null, sum('v'))).toBe(true);
		expect(splittable('y2', 'y2', column('v'))).toBe(true);
		expect(splittable('y2', null, 'v')).toBe(true);
	});

	it('does not split a mean, a max, a ratio or a distinct count summed into Other', () => {
		expect(splittable('y2', null, avg('v'))).toBe(false);
		expect(splittable('y2', null, max('v'))).toBe(false);
		expect(splittable('y2', null, sql`sum(a) / sum(b)`)).toBe(false);
		expect(splittable('y2', null, count('v').distinct())).toBe(false);
	});

	it('does not split when topN ranks by a channel other than the length', () => {
		expect(splittable('y2', 'fill', sum('v'))).toBe(false);
		expect(splittable(undefined, null, sum('v'))).toBe(false);
	});
});
