// src/lib/scales/scale-inference.test.js

import { describe, it, expect } from 'vitest';
import { inferScaleType } from './scale-inference.js';
import { count, sum, avg, column } from '@uwdata/mosaic-sql';

describe('inferScaleType', () => {
	describe('axis context', () => {
		it('date column → time', () => {
			expect(inferScaleType({ field: 'created_at', schemaType: 'date', context: 'axis' })).toBe(
				'time'
			);
		});

		it('number column → linear', () => {
			expect(inferScaleType({ field: 'price', schemaType: 'number', context: 'axis' })).toBe(
				'linear'
			);
		});

		it('string column → band', () => {
			expect(inferScaleType({ field: 'species', schemaType: 'string', context: 'axis' })).toBe(
				'band'
			);
		});

		it('boolean column → band', () => {
			expect(inferScaleType({ field: 'is_active', schemaType: 'boolean', context: 'axis' })).toBe(
				'band'
			);
		});

		it('aggregate expression → linear', () => {
			expect(inferScaleType({ field: count(), schemaType: null, context: 'axis' })).toBe('linear');
			expect(inferScaleType({ field: sum('revenue'), schemaType: null, context: 'axis' })).toBe(
				'linear'
			);
			expect(inferScaleType({ field: avg('delay'), schemaType: null, context: 'axis' })).toBe(
				'linear'
			);
		});
	});

	describe('visual context', () => {
		it('date column → sequential', () => {
			expect(inferScaleType({ field: 'created_at', schemaType: 'date', context: 'visual' })).toBe(
				'sequential'
			);
		});

		it('number column → sequential', () => {
			expect(inferScaleType({ field: 'price', schemaType: 'number', context: 'visual' })).toBe(
				'sequential'
			);
		});

		it('string column → ordinal', () => {
			expect(inferScaleType({ field: 'species', schemaType: 'string', context: 'visual' })).toBe(
				'ordinal'
			);
		});

		it('boolean column → ordinal', () => {
			expect(inferScaleType({ field: 'is_active', schemaType: 'boolean', context: 'visual' })).toBe(
				'ordinal'
			);
		});

		it('aggregate expression → sequential', () => {
			expect(inferScaleType({ field: count(), schemaType: null, context: 'visual' })).toBe(
				'sequential'
			);
		});
	});

	describe('size context', () => {
		it('number column → sqrt (perceptual)', () => {
			expect(inferScaleType({ field: 'population', schemaType: 'number', context: 'size' })).toBe(
				'sqrt'
			);
		});

		it('string column → ordinal', () => {
			expect(inferScaleType({ field: 'category', schemaType: 'string', context: 'size' })).toBe(
				'ordinal'
			);
		});

		it('aggregate expression → sqrt', () => {
			expect(inferScaleType({ field: sum('sales'), schemaType: null, context: 'size' })).toBe(
				'sqrt'
			);
		});
	});

	describe('blocking behavior', () => {
		it('string field with null schemaType → null (block)', () => {
			expect(inferScaleType({ field: 'unknown_col', schemaType: null, context: 'axis' })).toBe(
				null
			);
		});

		it('string field with undefined schemaType → null (block)', () => {
			expect(inferScaleType({ field: 'unknown_col', schemaType: undefined, context: 'axis' })).toBe(
				null
			);
		});

		it("SQL column node → null (not aggregate, can't look up)", () => {
			expect(inferScaleType({ field: column('x'), schemaType: null, context: 'axis' })).toBe(null);
		});
	});

	describe('fallbacks', () => {
		it('non-string, non-node field on axis → linear', () => {
			expect(inferScaleType({ field: 42, schemaType: null, context: 'axis' })).toBe('linear');
		});

		it('non-string, non-node field on visual → ordinal', () => {
			expect(inferScaleType({ field: null, schemaType: null, context: 'visual' })).toBe('ordinal');
		});

		it('non-string, non-node field on size → linear', () => {
			expect(inferScaleType({ field: [1, 2, 3], schemaType: null, context: 'size' })).toBe(
				'linear'
			);
		});
	});
});
