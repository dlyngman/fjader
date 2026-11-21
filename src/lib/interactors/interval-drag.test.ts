import { describe, it, expect, vi } from 'vitest';
import { scaleLinear } from 'd3-scale';
import { CellPixels, IntervalDrag1D, IntervalDrag2D, type DragScale } from './interval-drag.svelte';
import type { ChartContext } from '$lib/types';

/** 0–100 in data over 0–200 px: data = px / 2. */
const scale = scaleLinear().domain([0, 100]).range([0, 200]) as unknown as DragScale;
/** y, inverted as on screen: 0–100 over 200–0 px. */
const yScale = scaleLinear().domain([0, 100]).range([200, 0]) as unknown as DragScale;

function drag1D() {
	const sink = { range: vi.fn((_min: number, _max: number) => true), clear: vi.fn() };
	return { drag: new IntervalDrag1D(sink), sink };
}

describe('IntervalDrag1D', () => {
	const A = {};
	const B = {};

	it('draws a range in data space and writes it once per change', () => {
		const { drag, sink } = drag1D();
		expect(drag.press(A, 40, null)).toBe(true);
		drag.move(A, 100, scale);
		drag.move(A, 100, scale); // unchanged: no second write
		expect(drag.release(A)).toBe(true);

		expect(sink.range.mock.calls).toEqual([[20, 50]]);
		expect(drag.brush.phase).toBe('idle');
		expect([drag.brush.dataMin, drag.brush.dataMax]).toEqual([20, 50]);
	});

	it('belongs to the cell that pressed: another cell is declined, and its moves are not the drag', () => {
		const { drag, sink } = drag1D();
		drag.press(A, 40, null);
		drag.move(A, 100, scale);

		expect(drag.press(B, 10, null)).toBe(false);
		expect(drag.move(B, 180, scale)).toBe(false);
		expect(drag.release(B)).toBe(false);
		expect(drag.owns(A)).toBe(true);

		drag.release(A);
		expect(sink.range.mock.calls).toEqual([[20, 50]]);
		// Released: the next press, in any cell, may start a drag.
		expect(drag.press(B, 10, null)).toBe(true);
	});

	it('declines a press before the threshold is crossed, too', () => {
		const { drag } = drag1D();
		drag.press(A, 40, null);
		expect(drag.press(B, 10, null)).toBe(false);
	});

	it('a click on the plot clears an active brush', () => {
		const { drag, sink } = drag1D();
		drag.press(A, 40, null);
		drag.move(A, 100, scale);
		drag.release(A);

		drag.press(B, 150, null);
		drag.release(B);
		expect(sink.clear).toHaveBeenCalledTimes(1);
		expect(drag.brush.active).toBe(false);
	});

	it('moves by the handle and resizes by an edge, keeping min below max', () => {
		const { drag, sink } = drag1D();
		drag.press(A, 40, null);
		drag.move(A, 100, scale);
		drag.release(A);

		drag.press(A, 60, 'move');
		drag.move(A, 80, scale); // +20 px = +10
		drag.release(A);
		expect([drag.brush.dataMin, drag.brush.dataMax]).toEqual([30, 60]);

		// The start edge dragged past the end: the end stays fixed and becomes the min.
		drag.press(A, 60, 'left');
		drag.move(A, 160, scale);
		drag.release(A);
		expect(sink.range.mock.lastCall).toEqual([60, 80]);
	});

	it('a range the sink could not write (no column yet) is written by the next emit', () => {
		const { drag, sink } = drag1D();
		sink.range.mockReturnValueOnce(false);
		drag.press(A, 40, null);
		drag.move(A, 100, scale); // not written
		drag.release(A); // the same range: written now, not skipped as a duplicate
		expect(sink.range.mock.calls).toEqual([
			[20, 50],
			[20, 50]
		]);
	});

	it('is held while a cell owns a drag', () => {
		const { drag } = drag1D();
		expect(drag.held).toBe(false);
		drag.press(A, 40, null);
		expect(drag.held).toBe(true);
		drag.release(A);
		expect(drag.held).toBe(false);
	});

	it('an abandoned drag writes nothing more', () => {
		const { drag, sink } = drag1D();
		drag.press(A, 40, null);
		drag.move(A, 100, scale);
		sink.range.mockClear();
		drag.abandon(A);
		expect(sink.range).not.toHaveBeenCalled();
	});

	it('a drag its cell abandons (pan mode, unmount) keeps what it drew', () => {
		const { drag, sink } = drag1D();
		drag.press(A, 40, null);
		drag.move(A, 100, scale);
		drag.abandon(B); // not B's
		expect(drag.owns(A)).toBe(true);
		drag.abandon(A);
		expect(drag.owns(A)).toBe(false);
		expect(drag.brush.phase).toBe('idle');
		expect(sink.clear).not.toHaveBeenCalled();
		expect(drag.brush.active).toBe(true);
	});

	it('an external range is drawn and remembered, not written back', () => {
		const { drag, sink } = drag1D();
		drag.setExternal(10, 30);
		drag.emit();
		expect(sink.range).not.toHaveBeenCalled();
		expect(drag.brush.active).toBe(true);
	});

	it('clears when the domain no longer holds it', () => {
		const { drag, sink } = drag1D();
		drag.setExternal(10, 30);
		drag.validate([0, 100]);
		expect(sink.clear).not.toHaveBeenCalled();
		drag.validate([50, 100]);
		expect(sink.clear).toHaveBeenCalledTimes(1);
	});
});

describe('IntervalDrag2D', () => {
	const A = {};
	const B = {};

	it('draws a rectangle, declines other cells, and resizes by a corner', () => {
		const sink = {
			range: vi.fn((_x0: number, _x1: number, _y0: number, _y1: number) => true),
			clear: vi.fn()
		};
		const drag = new IntervalDrag2D(sink);
		drag.press(A, 40, 160, null);
		expect(drag.press(B, 0, 0, null)).toBe(false);
		drag.move(A, 100, 100, scale, yScale);
		drag.release(A);
		const round = (call: number[]) => call.map((v) => Math.round(v * 1e9) / 1e9);
		expect(sink.range.mock.calls.map(round)).toEqual([[20, 50, 20, 50]]);

		// The north-east corner: x max and y max move, the opposite corner stays.
		drag.press(A, 100, 100, 'ne');
		drag.move(A, 140, 60, scale, yScale);
		drag.release(A);
		expect(round(sink.range.mock.lastCall!)).toEqual([20, 70, 20, 70]);
	});
});

describe('CellPixels', () => {
	const cell = (w: number, h: number) => ({ innerWidth: w, innerHeight: h }) as ChartContext;

	it('measures in the cell in use, and keeps its size when it goes away', () => {
		const pixels = new CellPixels();
		expect([pixels.width, pixels.height]).toEqual([0, 0]);
		const a = cell(200, 100);
		const b = cell(300, 150);
		pixels.use(a);
		expect([pixels.width, pixels.height]).toEqual([200, 100]);
		pixels.release(b); // not the one in use
		pixels.use(b);
		pixels.release(b);
		expect([pixels.width, pixels.height]).toEqual([300, 150]);
	});
});
