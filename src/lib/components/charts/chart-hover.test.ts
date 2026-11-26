import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChartHover, SETTLE_MS } from './ChartHover.svelte';

describe('ChartHover', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('is hovered while the pointer is over any cell', () => {
		const h = new ChartHover();
		expect(h.hovered).toBe(false);
		h.set('a', true);
		h.set('b', true);
		h.set('a', false);
		expect(h.hovered).toBe(true);
		h.set('b', false);
		expect(h.hovered).toBe(false);
	});

	it('is gesturing while any cell pans', () => {
		const h = new ChartHover();
		h.pan('a', true);
		h.pan('b', true);
		h.pan('a', false);
		expect(h.gesturing).toBe(true);
		h.pan('b', false);
		expect(h.gesturing).toBe(false);
	});

	it('is gesturing until a wheel zoom has been quiet for SETTLE_MS', () => {
		vi.useFakeTimers();
		const h = new ChartHover();
		h.wheel();
		expect(h.gesturing).toBe(true);
		// Wheel events keep coming: still one gesture.
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(SETTLE_MS / 2);
			h.wheel();
		}
		expect(h.gesturing).toBe(true);
		vi.advanceTimersByTime(SETTLE_MS - 1);
		expect(h.gesturing).toBe(true);
		vi.advanceTimersByTime(1);
		expect(h.gesturing).toBe(false);
	});

	it('a stream of wheel events sets one timer, pushed back, not one each', () => {
		vi.useFakeTimers();
		const set = vi.spyOn(globalThis, 'setTimeout');
		const h = new ChartHover();
		for (let i = 0; i < 20; i++) {
			h.wheel();
			vi.advanceTimersByTime(10);
		}
		expect(set).toHaveBeenCalledTimes(1);
		h.destroy();
	});
});
