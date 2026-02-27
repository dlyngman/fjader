// src/lib/transforms/transforms.test.ts

import { describe, it, expect } from 'vitest';
import { filter, topN, stack, stackY, stackX, normalize } from './index';
import { TransformCompiler } from './TransformCompiler';
import { bin, AutoBinNode } from '../sql/bin';
import { Query, gt, sum, column } from '@uwdata/mosaic-sql';
import { ObjectDataAccessor } from '$lib/data/DataAccessor';

/** Helper: wrap plain objects as DataAccessor for tests. */
function toAccessor(data: Record<string, unknown>[]) {
	return new ObjectDataAccessor(data);
}

describe('Transforms', () => {
	describe('SQL Transforms', () => {
		it('filter() adds WHERE clause', () => {
			const q = Query.from('sales').select({ x: 'product', y: sum('revenue') });

			const transform = filter(gt('revenue', 0));
			const result = transform.apply(q);

			const sql = result.toString();
			expect(sql).toContain('WHERE');
			expect(sql).toMatch(/revenue.*> 0/);
		});
	});

	describe('JS Transforms', () => {
		it('topN() takes top items', () => {
			const data = toAccessor([
				{ x: 'A', y: 100 },
				{ x: 'B', y: 200 },
				{ x: 'C', y: 50 }
			]);

			const transform = topN(2);
			const result = transform.apply(data, { markType: 'bar', table: 't', x: 'x', y: 'y' });

			expect(result.length).toBe(2);
			expect(result.getColumn('x')?.[0]).toBe('B'); // Highest
			expect(result.getColumn('x')?.[1]).toBe('A');
		});

		it('topN() includes Others', () => {
			const data = toAccessor([
				{ x: 'A', y: 100 },
				{ x: 'B', y: 200 },
				{ x: 'C', y: 50 }
			]);

			const transform = topN(2, { includeOthers: true });
			const result = transform.apply(data, { markType: 'bar', table: 't', x: 'x', y: 'y' });

			expect(result.length).toBe(3);
			expect(result.getColumn('x')?.[2]).toBe('Other');
			expect(result.getColumn('y')?.[2]).toBe(50); // Sum of C
		});

		it('stack() calculates y0 and y1', () => {
			const data = toAccessor([
				{ x: 'Jan', y: 10, region: 'North' },
				{ x: 'Jan', y: 20, region: 'South' },
				{ x: 'Feb', y: 15, region: 'North' }
			]);

			const transform = stack();
			const result = transform.apply(data, { markType: 'bar', table: 't', x: 'x', y: 'y' });

			const y0 = result.getColumn('y0');
			const y1 = result.getColumn('y1');

			expect(result.length).toBe(3);
			expect(y0?.[0]).toBe(0);
			expect(y1?.[0]).toBe(10);
			expect(y0?.[1]).toBe(10);
			expect(y1?.[1]).toBe(30);
			// Feb group resets
			expect(y0?.[2]).toBe(0);
			expect(y1?.[2]).toBe(15);
		});

		it('stackY() works with series-first ordering (area/line data order)', () => {
			// Connected topology marks arrive sorted by series, then x
			const data = toAccessor([
				{ x: 'Jan', y: 10, series: 'North' },
				{ x: 'Feb', y: 15, series: 'North' },
				{ x: 'Jan', y: 20, series: 'South' },
				{ x: 'Feb', y: 25, series: 'South' }
			]);

			const transform = stackY();
			const result = transform.apply(data, { markType: 'area', table: 't', x: 'x', y: 'y' });

			const y0 = result.getColumn('y0') as Float32Array;
			const y1 = result.getColumn('y1') as Float32Array;

			// North at Jan: first in Jan group → y0=0, y1=10
			expect(y0[0]).toBe(0);
			expect(y1[0]).toBe(10);
			// North at Feb: first in Feb group → y0=0, y1=15
			expect(y0[1]).toBe(0);
			expect(y1[1]).toBe(15);
			// South at Jan: stacks on North → y0=10, y1=30
			expect(y0[2]).toBe(10);
			expect(y1[2]).toBe(30);
			// South at Feb: stacks on North → y0=15, y1=40
			expect(y0[3]).toBe(15);
			expect(y1[3]).toBe(40);
		});

		it('stackY() with expand offset normalizes to 0-1', () => {
			const data = toAccessor([
				{ x: 'Jan', y: 10, region: 'North' },
				{ x: 'Jan', y: 20, region: 'South' }
			]);

			const transform = stackY({ offset: 'expand' });
			const result = transform.apply(data, { markType: 'area', table: 't', x: 'x', y: 'y' });

			const y0 = result.getColumn('y0') as Float32Array;
			const y1 = result.getColumn('y1') as Float32Array;

			expect(y0[0]).toBeCloseTo(0);
			expect(y1[0]).toBeCloseTo(1 / 3); // 10/30
			expect(y0[1]).toBeCloseTo(1 / 3);
			expect(y1[1]).toBeCloseTo(1); // 30/30
		});

		it('stackX() creates x0 and x1', () => {
			const data = toAccessor([
				{ y: 'A', x: 10 },
				{ y: 'A', x: 20 }
			]);

			const transform = stackX();
			const result = transform.apply(data, { markType: 'bar', table: 't', x: 'x', y: 'y' });

			const x0 = result.getColumn('x0') as Float32Array;
			const x1 = result.getColumn('x1') as Float32Array;

			expect(x0[0]).toBe(0);
			expect(x1[0]).toBe(10);
			expect(x0[1]).toBe(10);
			expect(x1[1]).toBe(30);
		});

		it('normalize() scales stacked values to percentages', () => {
			// Pre-stack the data
			const stacked = toAccessor([
				{ x: 'Jan', y: 10, region: 'North' },
				{ x: 'Jan', y: 20, region: 'South' }
			]);

			const stackTransform = stackY();
			const stackedResult = stackTransform.apply(stacked, { markType: 'area', table: 't', x: 'x', y: 'y' });

			const normalizeTransform = normalize();
			const result = normalizeTransform.apply(stackedResult, { markType: 'area', table: 't', x: 'x', y: 'y' });

			const y0 = result.getColumn('y0') as Float32Array;
			const y1 = result.getColumn('y1') as Float32Array;

			expect(y0[0]).toBeCloseTo(0);
			expect(y1[0]).toBeCloseTo(100 / 3); // (10/30)*100
			expect(y0[1]).toBeCloseTo(100 / 3);
			expect(y1[1]).toBeCloseTo(100);
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

			expect(result.toString()).toContain('revenue');
			expect(result.toString()).toContain('> 0');
		});

		it('applies JS transforms via DataAccessor', () => {
			const compiler = new TransformCompiler([stackY()]);

			const data = toAccessor([
				{ x: 'A', y: 10 },
				{ x: 'A', y: 20 }
			]);

			const result = compiler.applyToData(data, { markType: 'bar', table: 't', x: 'x', y: 'y' });

			expect(result.getColumn('y0')).toBeTruthy();
			expect(result.getColumn('y1')).toBeTruthy();
		});

		it('hasStackTransform() detects stack', () => {
			const withStack = new TransformCompiler([stackY()]);
			const without = new TransformCompiler([topN(10)]);

			expect(withStack.hasStackTransform()).toBe(true);
			expect(without.hasStackTransform()).toBe(false);
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

		it('creates AutoBinNode for explicit step', () => {
			const result = bin('age', { step: 5 });

			expect(result).toBeInstanceOf(AutoBinNode);
			expect(result.isAutoBinNode).toBe(true);
			expect(result.options.step).toBe(5);
		});

		it('resolves AutoBinNode with field stats', () => {
			const autoBin = bin('age');

			const fieldInfo = {
				age: { min: 18, max: 75, type: 'number' }
			};

			const resolved = autoBin.resolve(fieldInfo, 'linear');

			// Should return a Mosaic SQL expression (binHistogram uses floor)
			expect(resolved.toString().toLowerCase()).toContain('floor');
		});

		it('resolves explicit step with correct offset for extent', () => {
			const autoBin = bin('age', { step: 5 });
			const offset1 = autoBin.withOffset(1);

			const fieldInfo = {
				age: { min: 18, max: 75, type: 'number' }
			};

			const base = autoBin.resolve(fieldInfo, 'linear').toString();
			const upper = offset1.resolve(fieldInfo, 'linear').toString();

			// Both should use floor, but offset version should differ
			expect(base.toLowerCase()).toContain('floor');
			expect(upper.toLowerCase()).toContain('floor');
			expect(base).not.toBe(upper);
		});
	});
});
