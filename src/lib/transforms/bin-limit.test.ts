/**
 * The most bins a binned axis can have and still be padded (binLimit): the
 * padding's row limit over what each bin is crossed with, from the one
 * derivation `dense()` refuses by (binCross).
 */

import { describe, it, expect } from 'vitest';
import { binCross, binLimit, DENSE_ROW_LIMIT } from './index';
import type { ChannelIdentity } from '$lib/types';

const id = (size: number): ChannelIdentity => ({ dim: `dim_${size}`, size, positional: false });
const BINNED = new Set(['x', 'x1', 'x2']);

describe('binLimit', () => {
	it('is the whole row limit with nothing beside the bins', () => {
		expect(binLimit(['x', 'x1', 'x2'], {}, BINNED)).toBe(DENSE_ROW_LIMIT);
	});

	it('divides by each other group key’s ids plus the absent one', () => {
		expect(binLimit(['x', 'fill'], { fill: id(9) }, BINNED)).toBe(1000);
		expect(binLimit(['x', 'fill', '__facet'], { fill: id(10), __facet: id(10) }, BINNED)).toBe(
			Math.floor(DENSE_ROW_LIMIT / 121)
		);
	});

	it('agrees with the rows the padding counts: the limit’s bins fit, one more does not', () => {
		const identity = { fill: id(6), __facet: id(3) };
		const keys = ['x', 'fill', '__facet'];
		const crossed = binCross(keys, keys, identity, BINNED) as { rowsPerBin: number };
		const limit = binLimit(keys, identity, BINNED);
		expect(limit * crossed.rowsPerBin).toBeLessThanOrEqual(DENSE_ROW_LIMIT);
		expect((limit + 1) * crossed.rowsPerBin).toBeGreaterThan(DENSE_ROW_LIMIT);
	});

	it('says nothing where padding refuses by itself, or cannot help', () => {
		// Before identity setup.
		expect(binLimit(['x', 'fill'], null, BINNED)).toBe(Infinity);
		// A group key with no dim.
		expect(binLimit(['x', 'fill'], {}, BINNED)).toBe(Infinity);
		// The series and facets alone pass the limit: no bin count fits.
		expect(binLimit(['x', 'fill', '__facet'], { fill: id(200), __facet: id(100) }, BINNED)).toBe(
			Infinity
		);
	});
});
