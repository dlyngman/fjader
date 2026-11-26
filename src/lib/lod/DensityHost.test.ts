/**
 * A mark that holds its points counts them itself: the density host sends no
 * count query for it, and asks the database for the others as before.
 */

import { describe, it, expect, vi } from 'vitest';
import { DensityHost, countRowsInView, type HeldCount } from './DensityHost.svelte';

function harness(countInView?: () => HeldCount, version?: () => number, countDebounceMs?: number) {
	const frames: Array<() => void> = [];
	const target: [number, number] = [0, 100];
	const query = vi.fn(async () => [{ cnt: 77 }]);
	const host = new DensityHost(
		{
			addFrameCallback: (fn: () => void) => frames.push(fn),
			removeFrameCallback: () => {}
		} as never,
		{ xScaleState: { domain: { target } }, yScaleState: null, innerWidth: 200 } as never,
		{ query } as never,
		{ callerId: 'm', countQueryBuilder: () => 'SELECT 1', countInView, version, countDebounceMs }
	);
	const frame = (lo = target[0], hi = target[1]) => {
		target[0] = lo;
		target[1] = hi;
		frames[0]();
	};
	return { host, query, frame };
}

describe('DensityHost', () => {
	it('takes the count from a mark that holds its points, and sends nothing', () => {
		let held = 40;
		const { host, query, frame } = harness(() => held);
		frame();
		expect(host.ctx.visibleCount).toBe(40);
		// Soon after: a view more than twice as narrow is counted at once.
		held = 12;
		frame(10, 40);
		expect(host.ctx.visibleCount).toBe(12);
		expect(query).not.toHaveBeenCalled();
	});

	it('counts a moving view no more often than a count query went out', () => {
		const count = vi.fn(() => 40);
		const { frame } = harness(count);
		frame();
		for (let lo = 1; lo <= 20; lo++) frame(lo, lo + 100);
		expect(count).toHaveBeenCalledTimes(1);
	});

	it('counts again when the rows changed under a view that did not move', () => {
		let held = 40;
		let version = 1;
		const count = vi.fn(() => held);
		const { host, frame } = harness(count, () => version, -1);
		frame();
		frame();
		frame();
		expect(count).toHaveBeenCalledTimes(1);
		held = 9;
		version = 2;
		frame();
		expect(host.ctx.visibleCount).toBe(9);
		expect(count).toHaveBeenCalledTimes(2);
	});

	it('a count put off is taken later, with no further frame: the last result is not left uncounted', async () => {
		let held = 40;
		let version = 1;
		const count = vi.fn(() => held);
		const { host, frame } = harness(count, () => version, 40);
		frame();
		// A new result straight after, under the same view: too soon to count.
		held = 7;
		version = 2;
		frame();
		expect(host.ctx.visibleCount).toBe(40);
		// No more frames. The count comes once the spacing has passed.
		await vi.waitFor(() => expect(host.ctx.visibleCount).toBe(7));
		expect(count).toHaveBeenCalledTimes(2);
	});

	it('a moving view that comes to rest is counted where it stopped', async () => {
		let held = 40;
		const { host, frame } = harness(() => held, undefined, 40);
		frame();
		held = 33;
		frame(5, 105);
		expect(host.ctx.visibleCount).toBe(40);
		await vi.waitFor(() => expect(host.ctx.visibleCount).toBe(33));
	});

	it('asks nothing while a mark waits for its first result, and counts once it has it', () => {
		let held: HeldCount = 'wait';
		const { host, query, frame } = harness(() => held);
		frame();
		frame();
		expect(query).not.toHaveBeenCalled();
		expect(host.ctx.visibleCount).toBe(0);
		held = 25;
		frame();
		expect(host.ctx.visibleCount).toBe(25);
		expect(query).not.toHaveBeenCalled();
	});

	it('asks the database for a mark that does not hold its points, once per view', async () => {
		const { host, query, frame } = harness(
			() => 'ask',
			() => 1
		);
		frame();
		frame();
		frame();
		expect(query).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(host.ctx.visibleCount).toBe(77));
	});

	it('sets no timer for a mark whose rows the database counts, however the view moves', () => {
		const { frame } = harness(
			() => 'ask',
			() => 1
		);
		frame();
		const timers = vi.spyOn(globalThis, 'setTimeout');
		for (let lo = 1; lo <= 30; lo++) frame(lo, lo + 100);
		expect(timers).not.toHaveBeenCalled();
		timers.mockRestore();
	});

	it('asks the database as before for a mark that says nothing', async () => {
		const { host, query, frame } = harness();
		frame();
		frame();
		expect(query).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(host.ctx.visibleCount).toBe(77));
	});
});

describe('countRowsInView', () => {
	const x = Float32Array.from([0, 0, 10, 10, 20, 20, 30, 30]);
	const y = Float32Array.from([1, 5, 2, NaN, 3, 50, 4, 8]);

	it('counts the rows whose x is in the view', () => {
		expect(countRowsInView(x, null, 10, 20, -Infinity, Infinity)).toBe(4);
		expect(countRowsInView(x, y, 10, 20, -Infinity, Infinity)).toBe(4);
	});

	it('and whose y is, with a finite y view: a NaN is in no range', () => {
		expect(countRowsInView(x, y, 0, 30, 0, 10)).toBe(6);
		expect(countRowsInView(x, y, 10, 20, 0, 10)).toBe(2);
	});
});
