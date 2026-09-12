import { describe, it, expect } from 'vitest';
import { ObjectDataAccessor } from '$lib/data/DataAccessor';
import { count, sum } from '@uwdata/mosaic-sql';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import {
	computeExtentFromData,
	extractCategoriesFromData,
	extractIdsRankedFromData,
	detectChannelsNeedingDataDomain
} from './domain-computation';
import { ColumnDataAccessor } from '$lib/data/DataAccessor';
import { TOPN_RANK_COLUMN } from '$lib/transforms';

describe('computeExtentFromData', () => {
	it('returns extent for single numeric channel', () => {
		const data = new ObjectDataAccessor([{ y: 10 }, { y: 20 }, { y: 5 }]);
		expect(computeExtentFromData(data, ['y'])).toEqual([5, 20]);
	});

	it('returns null for empty data', () => {
		const data = new ObjectDataAccessor([]);
		expect(computeExtentFromData(data, ['y'])).toBeNull();
	});

	it('returns [0, 0] when channel is missing (ObjectDataAccessor returns zero-filled)', () => {
		const data = new ObjectDataAccessor([{ x: 1 }]);
		// ObjectDataAccessor returns Float32Array of zeros for missing columns
		expect(computeExtentFromData(data, ['y'])).toEqual([0, 0]);
	});

	it('spans multiple channels (x1/x2)', () => {
		const data = new ObjectDataAccessor([
			{ x1: 0, x2: 10 },
			{ x1: 5, x2: 20 }
		]);
		expect(computeExtentFromData(data, ['x1', 'x2'])).toEqual([0, 20]);
	});

	// Viewport filtering now handled by DuckDB queries (fitDomain), not JS-side iteration

	it('ignores NaN values', () => {
		const data = new ObjectDataAccessor([{ y: NaN }, { y: 10 }, { y: NaN }]);
		expect(computeExtentFromData(data, ['y'])).toEqual([10, 10]);
	});

	it('works with plain object arrays', () => {
		const data = [{ x: 3 }, { x: 7 }, { x: 1 }];
		expect(computeExtentFromData(data, ['x'])).toEqual([1, 7]);
	});
});

describe('extractCategoriesFromData', () => {
	it('extracts unique categories preserving order', () => {
		const data = new ObjectDataAccessor([{ x: 'A' }, { x: 'B' }, { x: 'A' }, { x: 'C' }]);
		expect(extractCategoriesFromData(data, 'x')).toEqual(['A', 'B', 'C']);
	});

	it('returns ["0"] for missing column (ObjectDataAccessor returns zero-filled)', () => {
		const data = new ObjectDataAccessor([{ x: 1 }]);
		// ObjectDataAccessor returns Float32Array of zeros for missing columns
		expect(extractCategoriesFromData(data, 'y')).toEqual(['0']);
	});
});

describe('detectChannelsNeedingDataDomain', () => {
	it('detects aggregate on linear y', () => {
		const result = detectChannelsNeedingDataDomain(
			{ x: 'species', y: count() },
			{
				x: { type: 'band', priority: 2 },
				y: { type: 'linear', priority: 2 }
			},
			new TransformCompiler([])
		);
		expect(result.has('y')).toBe(true);
		expect(result.has('x')).toBe(false);
	});

	it('does not detect raw field on linear scale', () => {
		const result = detectChannelsNeedingDataDomain(
			{ x: 'price', y: 'quantity' },
			{
				x: { type: 'linear', priority: 2 },
				y: { type: 'linear', priority: 2 }
			},
			new TransformCompiler([])
		);
		expect(result.size).toBe(0);
	});

	it('detects aggregate color channel', () => {
		const result = detectChannelsNeedingDataDomain(
			{ x: 'a', y: 'b', fill: sum('revenue') },
			{
				x: { type: 'band', priority: 2 },
				y: { type: 'band', priority: 2 }
			},
			new TransformCompiler([])
		);
		expect(result.has('fill')).toBe(true);
	});
});

describe('extractIdsRankedFromData', () => {
	/** Rows as the pipeline delivers them: ids on the band channel, rank alongside. */
	function accessor(ids: number[], ranks?: number[]) {
		const cols: Record<string, Float32Array> = { x: Float32Array.from(ids) };
		if (ranks) cols[TOPN_RANK_COLUMN] = Float32Array.from(ranks);
		return new ColumnDataAccessor(cols, ids.length);
	}

	it('orders ids by the published rank, not by the order rows arrive in', () => {
		// The case the whole mechanism exists for. A bar mark stacks by default,
		// so the ranked query is wrapped in a window PARTITIONed by the band
		// column and the rows come back keyed by dim id. Reading row order here
		// is what put a topN axis in dim-id order; reading the rank does not.
		const data = accessor([1, 2, 0], [2, 3, 1]);
		expect(extractIdsRankedFromData(data, 'x', TOPN_RANK_COLUMN)).toEqual([0, 1, 2]);
	});

	it('falls back to first-appearance order when no rank was published', () => {
		// A grouped topN has no rank to publish and every other mark has no
		// ranking at all, so absence is the normal case rather than an error.
		const data = accessor([2, 0, 1]);
		expect(extractIdsRankedFromData(data, 'x', TOPN_RANK_COLUMN)).toEqual([2, 0, 1]);
	});

	it('keeps the best rank for an id that appears on several rows', () => {
		// A grouped result has one row per series per category and they need not
		// agree; the category ranks where its best row ranks.
		const data = accessor([5, 7, 5, 7], [4, 1, 2, 3]);
		expect(extractIdsRankedFromData(data, 'x', TOPN_RANK_COLUMN)).toEqual([7, 5]);
	});

	it('drops the not-displayed sentinel', () => {
		const data = accessor([-1, 3, -1, 1], [1, 2, 3, 4]);
		expect(extractIdsRankedFromData(data, 'x', TOPN_RANK_COLUMN)).toEqual([3, 1]);
	});

	it('leaves tied ranks in first-appearance order', () => {
		const data = accessor([9, 4, 6], [1, 1, 1]);
		expect(extractIdsRankedFromData(data, 'x', TOPN_RANK_COLUMN)).toEqual([9, 4, 6]);
	});
});
