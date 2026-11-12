import { describe, it, expect } from 'vitest';
import { registerDataDerivedDomains } from './domain-registration';
import { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';
import { ColumnDataAccessor } from '$lib/data/DataAccessor';
import { RANK_COLUMN } from '$lib/transforms';

/**
 * How a band axis takes its order from a query result.
 *
 * The rank arrives as a column, one reader for topN's ranking and the sort's.
 * What is decided here and nowhere else: a y axis is read from the top, and a
 * result without a rank column is not an opinion about order.
 */
describe('registerDataDerivedDomains on a band axis', () => {
	const VALUES = ['A', 'B', 'C', 'D'];

	function scale(): BandScaleState {
		const s = new BandScaleState('cat');
		s.setIdentity(new FieldIdentity(VALUES));
		return s;
	}

	/** Rows as the pipeline delivers them: ids on the band channel, rank alongside. */
	function rows(axis: 'x' | 'y', ids: number[], ranks?: number[]) {
		const cols: Record<string, Float32Array> = { [axis]: Float32Array.from(ids) };
		if (ranks) cols[RANK_COLUMN] = Float32Array.from(ranks);
		return new ColumnDataAccessor(cols, ids.length);
	}

	function register(axis: 'x' | 'y', data: ColumnDataAccessor, band: BandScaleState) {
		registerDataDerivedDomains(
			data,
			new Set(),
			[],
			null,
			undefined,
			axis === 'x' ? 'band' : 'linear',
			axis === 'y' ? 'band' : 'linear',
			null,
			null,
			true,
			axis === 'x' ? band : null,
			axis === 'y' ? band : null,
			'mark-1',
			false
		);
	}

	it('orders an x axis by the rank column, rank 1 first', () => {
		const s = scale();
		// Rows come back in id order; the rank says C, A, D, B.
		register('x', rows('x', [0, 1, 2, 3], [2, 4, 1, 3]), s);
		expect(s.effectiveDomain).toEqual(['C', 'A', 'D', 'B']);
	});

	it('ranks a y axis as an x axis, rank 1 first: slot 0 is the top', () => {
		const s = scale();
		register('y', rows('y', [0, 1, 2, 3], [2, 4, 1, 3]), s);
		expect(s.effectiveDomain).toEqual(['C', 'A', 'D', 'B']);
	});

	it('leaves a NaN-ranked row off the axis', () => {
		const s = scale();
		register('x', rows('x', [0, 1, 2, 3], [1, NaN, 2, NaN]), s);
		expect(s.effectiveDomain).toEqual(['A', 'C']);
	});

	it('takes first appearance without a rank column, and withdraws a ranking it had', async () => {
		const s = scale();
		register('x', rows('x', [0, 1, 2, 3], [2, 4, 1, 3]), s);
		expect(s.effectiveDomain).toEqual(['C', 'A', 'D', 'B']);

		// The same mark, its sort removed: rows in id order, no rank.
		register('x', rows('x', [0, 1, 2, 3]), s);
		expect(s.effectiveDomain).toEqual(['A', 'B', 'C', 'D']);
	});

	it('does not reverse a y axis whose rows carry no rank', () => {
		const s = scale();
		register('y', rows('y', [3, 1, 0, 2]), s);
		expect(s.effectiveDomain).toEqual(['D', 'B', 'A', 'C']);
	});
});
