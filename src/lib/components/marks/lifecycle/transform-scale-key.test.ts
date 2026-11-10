import { describe, it, expect } from 'vitest';
import { transformScaleKey } from './transform-scale-key';

describe('transformScaleKey', () => {
	it('is the same for marks of one chart, so a bar and its labels share an axis', () => {
		const chart = {};
		expect(transformScaleKey('t', 'Top 5 + Other (SQL)', chart)).toBe(
			transformScaleKey('t', 'Top 5 + Other (SQL)', chart)
		);
	});

	it('differs between two charts with the identical topN', () => {
		expect(transformScaleKey('t', 'Top 5 (SQL)', {})).not.toBe(
			transformScaleKey('t', 'Top 5 (SQL)', {})
		);
	});

	it('still separates tables and transforms within one chart', () => {
		const chart = {};
		const key = transformScaleKey('t', 'Top 5 (SQL)', chart);
		expect(transformScaleKey('u', 'Top 5 (SQL)', chart)).not.toBe(key);
		expect(transformScaleKey('t', 'Top 3 (SQL)', chart)).not.toBe(key);
	});
});
