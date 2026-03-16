import { describe, it, expect } from 'vitest';
import { ObjectDataAccessor } from '$lib/data/DataAccessor';
import { count, sum } from '@uwdata/mosaic-sql';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import {
	computeExtentFromData,
	extractCategoriesFromData,
	detectChannelsNeedingDataDomain
} from './domain-computation';

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
