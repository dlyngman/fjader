// src/lib/transforms/transforms.test.js

import { describe, it, expect } from 'vitest';
import { filter, topN, stack, normalize } from './index.js';
import { TransformCompiler } from './TransformCompiler.js';
import { bin, AutoBinNode } from '../sql/bin.js';
import { Query, gt, sum, column } from '@uwdata/mosaic-sql';

describe('Transforms', () => {
	describe('SQL Transforms', () => {
		it('filter() adds WHERE clause', () => {
			const q = Query.from('sales').select({ x: 'product', y: sum('revenue') });

			const transform = filter(gt('revenue', 0));
			const result = transform.apply(q);

			const sql = result.toString();
			expect(sql).toContain('WHERE');
			expect(sql).toContain('revenue > 0');
		});
	});

	describe('JS Transforms', () => {
		it('topN() takes top items', () => {
			const data = [
				{ x: 'A', y: 100 },
				{ x: 'B', y: 200 },
				{ x: 'C', y: 50 }
			];

			const transform = topN(2);
			const result = transform.apply(data, { x: 'x', y: 'y' });

			expect(result).toHaveLength(2);
			expect(result[0].x).toBe('B'); // Highest
			expect(result[1].x).toBe('A');
		});

		it('topN() includes Others', () => {
			const data = [
				{ x: 'A', y: 100 },
				{ x: 'B', y: 200 },
				{ x: 'C', y: 50 }
			];

			const transform = topN(2, { includeOthers: true });
			const result = transform.apply(data, { x: 'x', y: 'y' });

			expect(result).toHaveLength(3);
			expect(result[2].x).toBe('Other');
			expect(result[2].y).toBe(50); // Sum of C
		});

		it('stack() calculates y0 and y1', () => {
			const data = [
				{ x: 'Jan', y: 10, region: 'North' },
				{ x: 'Jan', y: 20, region: 'South' },
				{ x: 'Feb', y: 15, region: 'North' }
			];

			const transform = stack();
			const result = transform.apply(data, { x: 'x', y: 'y' });

			expect(result).toHaveLength(3);
			expect(result[0]).toHaveProperty('y0', 0);
			expect(result[0]).toHaveProperty('y1', 10);
			expect(result[1]).toHaveProperty('y0', 10);
			expect(result[1]).toHaveProperty('y1', 30);
		});
	});

	describe('TransformCompiler', () => {
		it('separates SQL and JS transforms', () => {
			const transforms = [filter(gt('revenue', 0)), topN(10), stack()];

			const compiler = new TransformCompiler(transforms);

			expect(compiler.sqlTransforms).toHaveLength(1);
			expect(compiler.jsTransforms).toHaveLength(2);
		});

		it('throws on invalid ordering', () => {
			const transforms = [
				topN(10), // JS
				filter(gt('x', 0)) // SQL - wrong order!
			];

			expect(() => new TransformCompiler(transforms)).toThrow(/Invalid transform order/);
		});

		it('applies SQL transforms to query', () => {
			const compiler = new TransformCompiler([filter(gt('revenue', 0))]);

			const q = Query.from('sales').select({ y: sum('revenue') });
			const result = compiler.applyToQuery(q);

			expect(result.toString()).toContain('WHERE revenue > 0');
		});

		it('detects CTEs', () => {
			const compiler = new TransformCompiler([]);

			// Simulate a query with CTE
			const badQuery = {
				toString: () => 'WITH temp AS (SELECT * FROM t) SELECT * FROM temp'
			};

			expect(() => compiler.validateQuery(badQuery)).toThrow(/CTE/);
		});
	});

	describe('Auto Binning', () => {
		it('creates AutoBinNode by default', () => {
			const result = bin('age');

			expect(result).toBeInstanceOf(AutoBinNode);
			expect(result.isAutoBinNode).toBe(true);
		});

		it('creates explicit SQL for step', () => {
			const result = bin('age', { step: 5 });

			expect(result.isAutoBinNode).toBeFalsy();
			expect(result.toString()).toContain('FLOOR');
		});

		it('resolves AutoBinNode with field stats', () => {
			const autoBin = bin('age');

			const fieldInfo = {
				age: { min: 18, max: 75, type: 'number' }
			};

			const resolved = autoBin.resolve(fieldInfo, 'linear');

			// Should return a Mosaic SQL expression
			expect(resolved.toString()).toContain('FLOOR');
		});
	});
});
