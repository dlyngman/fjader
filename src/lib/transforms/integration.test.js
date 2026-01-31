// src/lib/transforms/integration.test.js

import { describe, it, expect } from 'vitest';
import { Query, sum, count, gt, column } from '@uwdata/mosaic-sql';
import { filter, topN, stack } from './index.js';
import { TransformCompiler } from './TransformCompiler.js';
import { bin } from '../sql/bin.js';

describe('Transform Pipeline Integration', () => {
	it('full pipeline: SQL + JS transforms', () => {
		// Simulate a bar chart with stacking
		const transforms = [filter(gt('revenue', 0)), topN(10, { includeOthers: true }), stack()];

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

		// Validate flat query
		expect(() => compiler.validateQuery(query)).not.toThrow();

		const sql = query.toString();
		expect(sql).toContain('WHERE revenue > 0');
		expect(sql).not.toContain('WITH'); // No CTE

		// Simulate query results
		const mockData = [
			{ x: 'A', y: 1000, fill: 'North' },
			{ x: 'A', y: 500, fill: 'South' },
			{ x: 'B', y: 800, fill: 'North' }
			// ... more data
		];

		// Apply JS transforms
		const result = compiler.applyToData(mockData, {
			x: 'x',
			y: 'y',
			fill: 'fill'
		});

		// Verify stacking
		expect(result[0]).toHaveProperty('y0');
		expect(result[0]).toHaveProperty('y1');
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
