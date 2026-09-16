// src/lib/transforms/integration.test.js

import { describe, it, expect } from 'vitest';
import { Query, sum, count, gt, column } from '@uwdata/mosaic-sql';
import { filter, topN, stackY } from './index';
import { TransformCompiler } from './TransformCompiler';
import { bin } from '../sql/bin';
import { ObjectDataAccessor } from '$lib/data/DataAccessor';

describe('Transform Pipeline Integration', () => {
	it('full pipeline: SQL + JS transforms', () => {
		// Simulate a bar chart with stacking. A JS-engine topN, so
		// the stack that follows it must also be JS — SQL can't wrap client-side
		// transformed data.
		const transforms = [
			filter(gt('revenue', 0)),
			topN(10, { includeOthers: true, engine: 'js' }),
			stackY({ engine: 'js' })
		];

		const compiler = new TransformCompiler(transforms);

		// Build query
		let query = Query.from('sales')
			.select({
				x: 'product',
				y: sum('revenue'),
				fill: 'region'
			})
			.groupby('product', 'region');

		// Apply SQL transforms
		query = compiler.applyToQuery(query);

		const sql = query.toString();
		expect(sql).toMatch(/WHERE.*revenue.*> 0/);

		// Simulate query results
		const mockData = new ObjectDataAccessor([
			{ x: 'A', y: 1000, fill: 'North' },
			{ x: 'A', y: 500, fill: 'South' },
			{ x: 'B', y: 800, fill: 'North' }
		]);

		// Apply JS transforms
		const result = compiler.applyToData(mockData, {
			markType: 'bar',
			table: 'sales',
			x: 'x',
			y: 'y',
			fill: 'fill'
		});

		// Verify stacking
		expect(result.getColumn('y0')).toBeTruthy();
		expect(result.getColumn('y1')).toBeTruthy();
	});

	it('auto binning with transforms', () => {
		const x = bin('age'); // Auto bin
		const y = sum('revenue');

		// Check that AutoBinNode needs stats
		expect(x.isAutoBinNode).toBe(true);
		expect(x.stats).toEqual({
			column: 'age',
			stats: ['min', 'max']
		});

		// Simulate getting field stats
		const fieldInfo = {
			age: { min: 18, max: 75, type: 'number' }
		};

		// Resolve bin
		const resolvedX = x.resolve(fieldInfo, 'linear');

		// Build query with resolved bin
		const query = Query.from('sales')
			.select({
				x: resolvedX,
				y: y
			})
			.groupby(resolvedX);

		const sql = query.toString();
		expect(sql.toLowerCase()).toContain('floor');
		expect(sql).toContain('GROUP BY');
	});
});
