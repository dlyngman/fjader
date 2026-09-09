// src/lib/transforms/transforms.test.ts

import { describe, it, expect } from 'vitest';
import { filter, topN, stack, stackY, stackX, normalize, dodge, withImplicitStack } from './index';
import { TransformCompiler } from './TransformCompiler';
import { bin, AutoBinNode } from '../sql/bin';
import { Query, gt, sum, column, type SelectQuery } from '@uwdata/mosaic-sql';
import { ObjectDataAccessor, ColumnDataAccessor } from '$lib/data/DataAccessor';

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

			const transform = topN(2, { engine: 'js' });
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

		// --- includeOthers over an identity band column (§16.9) -------------
		//
		// After band step 3a the band channel is a Float32Array of dim ids, so
		// the string branch above is dead for any migrated axis. The synthetic
		// row cannot invent an id; the engine reserves one at setup and it
		// arrives through scales.otherIds.

		/** ids 0..2 = A,B,C; the Other bucket was reserved as id 3. */
		function idBandData() {
			return new ColumnDataAccessor(
				{ x: new Float32Array([0, 1, 2]), y: new Float32Array([100, 200, 50]) },
				3
			);
		}
		const markCfg = { markType: 'bar', table: 't', x: 'x', y: 'y' };

		it('topN() gives the Other row the reserved id, not a sum of excluded ids', () => {
			const result = topN(2, { includeOthers: true }).apply(idBandData(), markCfg, {
				otherIds: { x: 3 }
			});

			expect(result.length).toBe(3);
			// Was the sum of the excluded ids (2), which is category C's own id.
			expect(result.getColumn('x')?.[2]).toBe(3);
			expect(result.getColumn('y')?.[2]).toBe(50);
		});

		it('topN() omits the Other row when no id was reserved', () => {
			const result = topN(2, { includeOthers: true }).apply(idBandData(), markCfg);

			// Better a missing bar than one drawn on a live category's slot.
			expect(result.length).toBe(2);
			expect(Array.from(result.getColumn('x') as Float32Array)).toEqual([1, 0]);
		});

		it('topN() folds into a surviving category that already holds the reserved id', () => {
			// A real category literally named "Other" — reserveSynthetic reuses its
			// id rather than duplicating the value, so here id 1 is both a kept
			// category and the bucket. Appending would draw two bars in one slot.
			const data = new ColumnDataAccessor(
				{ x: new Float32Array([0, 1, 2]), y: new Float32Array([100, 200, 50]) },
				3
			);
			const result = topN(2, { includeOthers: true }).apply(data, markCfg, {
				otherIds: { x: 1 }
			});

			expect(result.length).toBe(2);
			const xs = Array.from(result.getColumn('x') as Float32Array);
			const ys = Array.from(result.getColumn('y') as Float32Array);
			// B (id 1) kept its slot and absorbed C's 50.
			expect(xs).toEqual([1, 0]);
			expect(ys[xs.indexOf(1)]).toBe(250);
		});

		it('topN() keeps the string path for a band column with no identity', () => {
			const data = toAccessor([
				{ x: 'A', y: 100 },
				{ x: 'B', y: 200 },
				{ x: 'C', y: 50 }
			]);
			const result = topN(2, { includeOthers: true }).apply(data, markCfg);

			expect(result.getColumn('x')?.[2]).toBe('Other');
		});

		it('topN() with series gives Other rows the reserved id, not 0', () => {
			// Grouped path: ids 0..2 across two series. Other rows used to get 0,
			// which is category A's id — the Other bar landed on top of it.
			const data = new ColumnDataAccessor(
				{
					x: new Float32Array([0, 0, 1, 1, 2, 2]),
					y: new Float32Array([50, 50, 90, 90, 10, 10]),
					fill: ['n', 's', 'n', 's', 'n', 's']
				},
				6
			);
			const result = topN(1, { includeOthers: true }).apply(
				data,
				{ ...markCfg, fill: 'fill' },
				{ otherIds: { x: 3 } }
			);

			const xs = Array.from(result.getColumn('x') as Float32Array);
			expect(xs.slice(0, 2)).toEqual([1, 1]);
			expect(xs.slice(2)).toEqual([3, 3]);
			expect(xs).not.toContain(0);
		});

		it('stack() calculates y0 and y1', () => {
			const data = toAccessor([
				{ x: 'Jan', y: 10, region: 'North' },
				{ x: 'Jan', y: 20, region: 'South' },
				{ x: 'Feb', y: 15, region: 'North' }
			]);

			const transform = stackY({ engine: 'js' });
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

			const transform = stackY({ engine: 'js' });
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

			const transform = stackY({ offset: 'expand', engine: 'js' });
			const result = transform.apply(data, { markType: 'area', table: 't', x: 'x', y: 'y' });

			const y0 = result.getColumn('y0') as Float32Array;
			const y1 = result.getColumn('y1') as Float32Array;

			expect(y0[0]).toBeCloseTo(0);
			expect(y1[0]).toBeCloseTo(1 / 3); // 10/30
			expect(y0[1]).toBeCloseTo(1 / 3);
			expect(y1[1]).toBeCloseTo(1); // 30/30
		});

		it('stackY() preserves NaN for gap semantics', () => {
			// NaN in value column (represents Arrow null from DuckDB) must propagate
			// to y0/y1 so GPU shaders can discard vertices and create gaps.
			// stackY groups by x, accumulates y — NaN rows get NaN output
			// without poisoning the group's cumulative sum.
			const data = toAccessor([
				{ x: 'Jan', y: 10, series: 'A' },
				{ x: 'Feb', y: NaN, series: 'A' },
				{ x: 'Mar', y: 20, series: 'A' },
				{ x: 'Jan', y: 5, series: 'B' },
				{ x: 'Feb', y: 15, series: 'B' }
			]);

			const transform = stackY({ engine: 'js' });
			const result = transform.apply(data, { markType: 'area', table: 't', x: 'x', y: 'y' });

			const y0 = result.getColumn('y0') as Float32Array;
			const y1 = result.getColumn('y1') as Float32Array;

			// Row 0: A at Jan → first in group, y0=0, y1=10
			expect(y0[0]).toBe(0);
			expect(y1[0]).toBe(10);
			// Row 1: A at Feb → NaN propagates to both y0 and y1
			expect(y0[1]).toBeNaN();
			expect(y1[1]).toBeNaN();
			// Row 2: A at Mar → new group, y0=0, y1=20
			expect(y0[2]).toBe(0);
			expect(y1[2]).toBe(20);
			// Row 3: B at Jan → stacks on A's Jan (cum=10), y0=10, y1=15
			expect(y0[3]).toBe(10);
			expect(y1[3]).toBe(15);
			// Row 4: B at Feb → NaN didn't increment Feb's cumulative, y0=0, y1=15
			expect(y0[4]).toBe(0);
			expect(y1[4]).toBe(15);
		});

		it('stackX() creates x0 and x1', () => {
			const data = toAccessor([
				{ y: 'A', x: 10 },
				{ y: 'A', x: 20 }
			]);

			const transform = stackX({ engine: 'js' });
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

			const stackTransform = stackY({ engine: 'js' });
			const stackedResult = stackTransform.apply(stacked, {
				markType: 'area',
				table: 't',
				x: 'x',
				y: 'y'
			});

			const normalizeTransform = normalize({ engine: 'js' });
			const result = normalizeTransform.apply(stackedResult, {
				markType: 'area',
				table: 't',
				x: 'x',
				y: 'y'
			});

			const y0 = result.getColumn('y0') as Float32Array;
			const y1 = result.getColumn('y1') as Float32Array;

			expect(y0[0]).toBeCloseTo(0);
			expect(y1[0]).toBeCloseTo(100 / 3); // (10/30)*100
			expect(y0[1]).toBeCloseTo(100 / 3);
			expect(y1[1]).toBeCloseTo(100);
		});
	});

	describe('withImplicitStack', () => {
		it('adds stack when series grouping exists and no explicit bounds', () => {
			const result = withImplicitStack([], false, 'y');
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('stack');
		});

		it('skips stack when explicit bounds are set', () => {
			const result = withImplicitStack([], true, 'y');
			expect(result).toHaveLength(0);
		});

		it('skips stack when already present in transforms', () => {
			const result = withImplicitStack([stackY()], false, 'y');
			expect(result).toHaveLength(1); // no duplicate
		});

		it('adds SQL stack by default (no preceding JS transform)', () => {
			const result = withImplicitStack([topN(5)], false, 'y');
			expect(result[1].stage).toBe('sql');
		});

		it('adds JS stack after a JS-stage transform (e.g. topN includeOthers), never SQL-after-JS', () => {
			const result = withImplicitStack([topN(5, { includeOthers: true })], false, 'y');
			expect(result[1].stage).toBe('js');
			// Must not throw — this is the regression: the auto-injected stack
			// used to always default to SQL, appended after a JS transform.
			expect(() => new TransformCompiler(result)).not.toThrow();
		});
	});

	describe('TransformCompiler', () => {
		it('separates SQL and JS transforms', () => {
			const transforms = [filter(gt('revenue', 0)), topN(10), stack(), dodge()];

			const compiler = new TransformCompiler(transforms);

			expect(compiler.sqlTransforms).toHaveLength(3); // filter + topN + stack (SQL by default)
			expect(compiler.jsTransforms).toHaveLength(1); // dodge
		});

		it('throws on invalid ordering', () => {
			const transforms = [
				stackY({ engine: 'js' }), // JS
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

		it('applies SQL topN CTE to query using mark config aliases', () => {
			const compiler = new TransformCompiler([topN(3)], {
				markType: 'bary',
				table: 'sales',
				x: 'x',
				y: 'y2'
			});

			const q = Query.from('sales')
				.select({ x: column('category'), y2: sum('revenue') })
				.groupby(column('category'));
			const sql = compiler.applyToQuery(q).toString();

			expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(ORDER BY "y2" DESC\)/);
			expect(sql).toMatch(/"__topn_rank" <= 3/);
		});

		it('SQL topN swaps axes for barx', () => {
			const compiler = new TransformCompiler([topN(3)], {
				markType: 'barx',
				table: 'sales',
				x: 'x2',
				y: 'y'
			});

			const q = Query.from('sales')
				.select({ x2: sum('revenue'), y: column('category') })
				.groupby(column('category'));
			const sql = compiler.applyToQuery(q).toString();

			expect(sql).toMatch(/ORDER BY "x2" DESC/);
		});

		it('SQL topN throws a clear error when the value alias is missing', () => {
			const compiler = new TransformCompiler([topN(3)], {
				markType: 'bary',
				table: 'sales',
				x: 'x',
				y: 'y'
			});

			const q = Query.from('sales')
				.select({ x: column('category'), y2: sum('revenue') })
				.groupby(column('category'));

			expect(() => compiler.applyToQuery(q)).toThrow(/value column "y" not in query select/);
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
