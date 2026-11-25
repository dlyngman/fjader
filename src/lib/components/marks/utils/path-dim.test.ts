import { describe, it, expect } from 'vitest';
import { bin, isBinExpression } from '$lib/sql/bin';
import { pathDimChannels, pathDimTooltipColumns } from './path-dim';

describe('pathDimChannels', () => {
	it('leaves a plain column or expression as its one channel', () => {
		expect(pathDimChannels('x', 'hour')).toEqual({ x: 'hour' });
		expect(Object.keys(pathDimChannels('y', 'hour'))).toEqual(['y']);
	});

	it("puts a bin()'s point at the bin's centre and brings its two edges", () => {
		const channels = pathDimChannels('x', bin('delay', { steps: 50 }));
		expect(Object.keys(channels)).toEqual(['x', 'x1', 'x2']);
		for (const node of Object.values(channels)) expect(isBinExpression(node)).toBe(true);
		const offsets = Object.values(channels).map(
			(node) => (node as ReturnType<typeof bin>).options.offset
		);
		expect(offsets).toEqual([0.5, 0, 1]);
		// The same bins, on all three.
		for (const node of Object.values(channels)) {
			expect((node as ReturnType<typeof bin>).options.steps).toBe(50);
			expect((node as ReturnType<typeof bin>).field).toBe('delay');
		}
	});

	it('names the edges after the axis the path runs along', () => {
		expect(Object.keys(pathDimChannels('y', bin('delay')))).toEqual(['y', 'y1', 'y2']);
	});

	it('keeps an offset the bin() was given: a daily count at its date', () => {
		const channels = pathDimChannels('x', bin('date', { interval: 'day', offset: 0 }));
		const offsets = Object.values(channels).map(
			(node) => (node as ReturnType<typeof bin>).options.offset
		);
		expect(offsets).toEqual([0, 0, 1]);
	});
});

describe('pathDimTooltipColumns', () => {
	it("gives a bin()'s edges as the axis's low and high, so the tooltip shows a range", () => {
		expect(pathDimTooltipColumns('x', bin('delay'))).toEqual({ xLow: 'x1', xHigh: 'x2' });
		expect(pathDimTooltipColumns('y', bin('delay'))).toEqual({ yLow: 'y1', yHigh: 'y2' });
	});

	it('gives nothing for a plain column', () => {
		expect(pathDimTooltipColumns('x', 'hour')).toEqual({});
	});
});
