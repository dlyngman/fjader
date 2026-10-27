import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HoverSettle } from './hover-settle';

const INTERVAL = 200;

describe('HoverSettle', () => {
	let lastFilterChangeAt: number;
	let view: number[];
	let settles: number;
	let settle: HoverSettle;

	beforeEach(() => {
		vi.useFakeTimers();
		lastFilterChangeAt = 0;
		view = [0, 100, 0, 50, 400, 300];
		settles = 0;
		settle = new HoverSettle({
			interval: INTERVAL,
			lastFilterChangeAt: () => lastFilterChangeAt,
			view: (out) => out.set(view),
			settle: () => settles++,
			now: () => Date.now()
		});
		settle.enter();
	});

	afterEach(() => {
		settle.leave();
		vi.useRealTimers();
	});

	const filterChange = () => (lastFilterChangeAt = Date.now());

	it('does nothing while nothing changes', () => {
		vi.advanceTimersByTime(INTERVAL * 10);
		expect(settles).toBe(0);
	});

	it('re-arms once after a filter change has been quiet for the interval', () => {
		vi.advanceTimersByTime(50);
		filterChange();
		vi.advanceTimersByTime(INTERVAL - 10);
		expect(settles).toBe(0);
		vi.advanceTimersByTime(INTERVAL * 2);
		expect(settles).toBe(1);
		vi.advanceTimersByTime(INTERVAL * 10);
		expect(settles).toBe(1);
	});

	it('waits out a burst of changes (a three-click multi-select)', () => {
		for (let i = 0; i < 3; i++) {
			filterChange();
			vi.advanceTimersByTime(120);
		}
		expect(settles).toBe(0);
		vi.advanceTimersByTime(INTERVAL * 2);
		expect(settles).toBe(1);
	});

	it('does not re-arm while a pointer is held, and does once it is released', () => {
		settle.hold(true);
		filterChange();
		vi.advanceTimersByTime(INTERVAL * 10);
		expect(settles).toBe(0);
		settle.hold(false);
		vi.advanceTimersByTime(INTERVAL * 2);
		expect(settles).toBe(1);
	});

	it('re-arms after the view changes and then holds still (a zoom, a resize)', () => {
		view = [10, 60, 0, 50, 400, 300];
		vi.advanceTimersByTime(INTERVAL * 3);
		expect(settles).toBe(1);
	});

	it('waits while the view keeps moving (an animated reset)', () => {
		for (let i = 1; i <= 5; i++) {
			view = [i, 100 + i, 0, 50, 400, 300];
			vi.advanceTimersByTime(INTERVAL);
		}
		expect(settles).toBe(0);
		vi.advanceTimersByTime(INTERVAL * 3);
		expect(settles).toBe(1);
	});

	it('stops when the pointer leaves', () => {
		settle.leave();
		filterChange();
		vi.advanceTimersByTime(INTERVAL * 10);
		expect(settles).toBe(0);
	});
});
