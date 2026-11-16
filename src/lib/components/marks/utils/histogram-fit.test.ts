import { describe, it, expect } from 'vitest';
import { histogramFitAxis } from './histogram-fit';

const ALL = [undefined, true, false, 'x', 'y'] as const;

describe('the axis a Rect mark fits', () => {
	it('vertical histogram (RectYMark, bins on x): the count axis is y', () => {
		expect(ALL.map((fd) => histogramFitAxis(fd, true, 'y'))).toEqual(['y', 'y', null, 'x', 'y']);
	});

	it('horizontal histogram (RectXMark, bins on y): the count axis is x', () => {
		expect(ALL.map((fd) => histogramFitAxis(fd, true, 'x'))).toEqual(['x', 'x', null, 'x', 'y']);
	});

	it('not a histogram: no default; true means y, as before', () => {
		for (const countAxis of ['x', 'y'] as const) {
			expect(ALL.map((fd) => histogramFitAxis(fd, false, countAxis))).toEqual([
				null,
				'y',
				null,
				'x',
				'y'
			]);
		}
	});
});
