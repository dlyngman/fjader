/**
 * A mark re-bins when the rebin level of its view changes and the resolved bins
 * differ: decided from the view alone, with no baseline of the rung's own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveBinRung } from './AdaptiveBinRung.svelte';
import { bin, rebinLevel } from '$lib/sql/bin';

const INFO = { v: { min: 0, max: 1000 } };

function harness() {
	const frames: Array<() => void> = [];
	const coordinator = {
		addFrameCallback: (fn: () => void) => frames.push(fn),
		removeFrameCallback: (fn: () => void) => frames.splice(frames.indexOf(fn), 1)
	};
	const target: [number, number] = [0, 1000];
	const chart = {
		xScaleState: { domain: { target } },
		yScaleState: null,
		innerWidth: 400,
		innerHeight: 300,
		binStepMultiplier: 1
	};
	/** A mark: its rung, the domain its bins were last resolved at, its re-bins. */
	const mark = (differ = true) => {
		const state = { domain: null as [number, number] | null, rebins: [] as number[][], asked: 0 };
		const rung = new AdaptiveBinRung(coordinator as never, chart as never, {
			binAxes: ['x'],
			setParam: () => {},
			getData: () => ({ getColumn: () => null, length: 3 }),
			levelOf: (_axis, lo, hi) => rebinLevel(hi - lo, 1000),
			binsDiffer: () => {
				state.asked++;
				return differ;
			},
			triggerReBin: (_axis, domain) => {
				state.domain = [domain[0], domain[1]];
				state.rebins.push([domain[0], domain[1]]);
			}
		});
		return { rung, state, bins: () => bin('v').padding(INFO, 'linear', state.domain) };
	};
	/** Move the view, render a frame, and let the debounce run. */
	const view = (lo: number, hi: number) => {
		target[0] = lo;
		target[1] = hi;
		for (const frame of [...frames]) frame();
		vi.advanceTimersByTime(20);
	};
	return { mark, view, frames };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AdaptiveBinRung', () => {
	it('does not re-bin on a pan, however far', () => {
		const { mark, view } = harness();
		const a = mark();
		view(0, 1000);
		view(0, 300);
		expect(a.state.rebins).toHaveLength(1);
		for (let lo = 0; lo <= 700; lo += 70) view(lo, lo + 300);
		expect(a.state.rebins).toHaveLength(1);
	});

	it('re-bins when the view reaches another level, to the view at that moment', () => {
		const { mark, view } = harness();
		const a = mark();
		view(0, 1000);
		view(0, 900);
		expect(a.state.rebins).toEqual([]);
		view(0, 600);
		expect(a.state.rebins).toEqual([[0, 600]]);
	});

	it('two marks seeded apart have the same bins at every view', () => {
		const { mark, view } = harness();
		const first = mark();
		view(0, 1000);
		view(0, 520);
		// The second mounts after the view has moved, and sees other frames.
		const second = mark();
		const widths = [520, 470, 410, 300, 260, 150, 90, 200, 480, 760, 1000, 640];
		for (const width of widths) {
			view(100, 100 + width);
			expect(second.bins()).toEqual(first.bins());
		}
		expect(first.state.rebins.length).toBeGreaterThan(3);
	});

	it('comes back to the same bins after zooming in and out', () => {
		const { mark, view } = harness();
		const a = mark();
		view(0, 400);
		const before = a.bins();
		view(0, 30);
		expect(a.bins()).not.toEqual(before);
		view(200, 600);
		expect(a.bins()).toEqual(before);
	});

	it('sends nothing when the bins at the new level are the same, and asks once', () => {
		const { mark, view } = harness();
		const a = mark(false);
		view(0, 1000);
		view(0, 600);
		view(0, 600);
		view(10, 610);
		expect(a.state.rebins).toEqual([]);
		expect(a.state.asked).toBe(1);
	});

	it('re-bins on a change of the step multiplier, at the view it has', () => {
		const { mark, view, frames } = harness();
		const a = mark();
		view(0, 1000);
		expect(a.state.rebins).toEqual([]);
		// The harness's chart object is the rung's: the frame callback reads it.
		a.rung.adjustResolution(-1);
		expect(frames).toHaveLength(1);
	});

	it('allocates no view per frame: the viewport callback gets the same buffer', () => {
		const seen = new Set<unknown>();
		const frames: Array<() => void> = [];
		const rung = new AdaptiveBinRung(
			{
				addFrameCallback: (fn: () => void) => frames.push(fn),
				removeFrameCallback: () => {}
			} as never,
			{ xScaleState: { domain: { target: [0, 1000] } }, binStepMultiplier: 1 } as never,
			{
				binAxes: ['x'],
				setParam: () => {},
				getData: () => ({ getColumn: () => null, length: 1 }),
				levelOf: () => 0,
				binsDiffer: () => true,
				triggerReBin: () => {},
				onViewport: (_axis, domain) => seen.add(domain)
			}
		);
		for (let i = 0; i < 5; i++) frames[0]();
		expect(seen.size).toBe(1);
		rung.destroy();
	});
});
