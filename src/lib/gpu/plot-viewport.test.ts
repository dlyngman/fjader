import { describe, expect, it } from 'vitest';
import { computePlotViewport, emptyPlotViewport } from './plot-viewport';

describe('computePlotViewport', () => {
	it('places the plot at its margins, in device pixels, unrounded', () => {
		// A 400×300 cell with margins 40 left, 20 top, 10 right, 30 bottom at DPR 1.8.
		const v = computePlotViewport(
			{ x: 40, y: 20, width: 350, height: 250 },
			1.8,
			Math.ceil(400 * 1.8),
			Math.ceil(300 * 1.8),
			emptyPlotViewport()
		);
		expect(v.x).toBeCloseTo(72);
		expect(v.y).toBeCloseTo(36);
		expect(v.width).toBeCloseTo(630);
		expect(v.height).toBeCloseTo(450);
		expect(v.drawable).toBe(true);
	});

	it('puts the origin on a whole device pixel, keeps the size, rounds the scissor', () => {
		const v = computePlotViewport(
			{ x: 33, y: 7, width: 101, height: 51 },
			1.5,
			300,
			200,
			emptyPlotViewport()
		);
		// x 49.5 → 50, y 10.5 → 11: a label snapped to a whole plot pixel then
		// sits on a whole device pixel.
		expect(v.x).toBe(50);
		expect(v.y).toBe(11);
		// The size stays exact: 151.5 by 76.5.
		expect(v.width).toBeCloseTo(151.5);
		expect(v.height).toBeCloseTo(76.5);
		// The scissor rounds its edges: 50 + 151.5 → 202, 11 + 76.5 → 88.
		expect(v.scissorX).toBe(50);
		expect(v.scissorX + v.scissorWidth).toBe(202);
		expect(v.scissorY).toBe(11);
		expect(v.scissorY + v.scissorHeight).toBe(88);
	});

	it('never reaches past the texture', () => {
		// No right margin, and a cell width the texture rounds up to.
		const v = computePlotViewport(
			{ x: 10, y: 0, width: 90.4, height: 50 },
			2,
			201,
			100,
			emptyPlotViewport()
		);
		expect(v.x + v.width).toBeLessThanOrEqual(201);
		expect(v.scissorX + v.scissorWidth).toBeLessThanOrEqual(201);
		expect(v.y + v.height).toBeLessThanOrEqual(100);
	});

	it('is not drawable without pixels', () => {
		const out = emptyPlotViewport();
		expect(
			computePlotViewport({ x: 10, y: 10, width: 0, height: 50 }, 2, 100, 100, out).drawable
		).toBe(false);
		expect(
			computePlotViewport({ x: 10, y: 10, width: 50, height: 50 }, 2, 0, 0, out).drawable
		).toBe(false);
	});

	it('writes into the object it is given', () => {
		const out = emptyPlotViewport();
		expect(computePlotViewport({ x: 1, y: 1, width: 10, height: 10 }, 1, 20, 20, out)).toBe(out);
	});
});
