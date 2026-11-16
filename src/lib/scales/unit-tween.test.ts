import { describe, it, expect } from 'vitest';
import { LinearScaleState } from './LinearScaleState.svelte';
import { LogScaleState } from './LogScaleState.svelte';
import { Spring, SPRING_PRESETS } from '$lib/animation';

/** A scale on screen: entered, at [lo, hi]. */
function onScreen<T extends LinearScaleState>(scale: T, lo: number, hi: number): T {
	scale.entered = true;
	scale.domain.set([lo, hi], { instant: true });
	return scale;
}

/** Run the scale's frames until at rest (capped), recording each frame's render domain. */
function frames(scale: LinearScaleState, cap = 2000): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 0; i < cap; i++) {
		scale.step();
		scale.updateRenderState(0);
		const [lo, hi] = scale.domain.current;
		out.push([lo, hi]);
		if (scale.isAtRest()) break;
	}
	return out;
}

/** Where v sits across [lo, hi] (0 bottom, 1 top), in the scale's own space `g`. */
const at = (v: number, [lo, hi]: [number, number], g = (x: number) => x) =>
	(g(v) - g(lo)) / (g(hi) - g(lo));

/**
 * How far each value's fraction of its pixel path strays from `progress`
 * (one number per frame): 0 means every value moves linearly in pixels, on
 * that profile.
 */
function stray(
	domains: [number, number][],
	progress: number[],
	from: [number, number],
	to: [number, number],
	values: number[],
	g?: (x: number) => number
): number {
	let worst = 0;
	domains.forEach((d, i) => {
		for (const v of values) {
			const f = (at(v, d, g) - at(v, from, g)) / (at(v, to, g) - at(v, from, g));
			worst = Math.max(worst, Math.abs(f - progress[i]));
		}
	});
	return worst;
}

/** A spring from 0 to 1 at the tween's stiffness, frame by frame: the progress it should follow. */
function springProgress(n: number): number[] {
	const ref = new Spring(0, SPRING_PRESETS.reset.stiffness, 1e-12);
	ref.setTarget(1);
	return Array.from({ length: n }, () => (ref.step(), ref.current));
}

describe('a unit-change tween', () => {
	it('moves every value linearly in pixels, on the spring’s progress', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.folding(() => s.domain.set([0, 100], { instant: true }));
		const run = frames(s);
		const p = springProgress(run.length);
		// To the tween's rest precision: on its last frame it lands exactly on the
		// target while the reference spring is still within 1e-4 of 1.
		expect(stray(run, p, [0, 700], [0, 100], [10, 50, 90])).toBeLessThan(1e-4);
	});

	it('which an endpoint spring does not: a fixed value hugs the floor, then rushes', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.domain.set([0, 100]);
		const run = frames(s);
		// Its own endpoint's progress, against which a value at 50 lags far behind.
		const p = run.map(([, hi]) => (hi - 700) / (100 - 700));
		expect(stray(run, p, [0, 700], [0, 100], [50])).toBeGreaterThan(0.2);
	});

	it('ends exactly on the target, at rest, and reports the target throughout', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.folding(() => s.domain.set([0, 100], { instant: true }));
		expect(s.domain.target).toEqual([0, 100]);
		expect(s.isAtRest()).toBe(false);
		const run = frames(s);
		expect(s.isAtRest()).toBe(true);
		expect(run[run.length - 1][0]).toBeCloseTo(0, 6);
		expect(run[run.length - 1][1]).toBeCloseTo(100, 6);
		expect(s.domain.target).toEqual([0, 100]);
	});

	it('does not move on its first frame: it starts from what is drawn', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.folding(() => s.domain.set([0, 100], { instant: true }));
		s.updateRenderState(0);
		expect(s.domain.current[0]).toBeCloseTo(0, 9);
		expect(s.domain.current[1]).toBeCloseTo(700, 9);
	});

	it('retargets mid-way without a jump: back-to-back changes continue from where they are', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.folding(() => s.domain.set([0, 100], { instant: true }));
		const first = frames(s, 20);
		const before = first[first.length - 1];
		s.folding(() => s.domain.set([0, 20], { instant: true }));
		s.updateRenderState(0);
		const after = s.domain.current;
		// Same frame time: the retarget itself moves nothing.
		expect(after[0]).toBeCloseTo(before[0], 6);
		expect(after[1]).toBeCloseTo(before[1], 6);
		const rest = frames(s);
		expect(rest[rest.length - 1][1]).toBeCloseTo(20, 6);
		// And frame to frame it stays smooth: no step bigger than early ones.
		let biggest = 0;
		for (let i = 1; i < rest.length; i++) {
			biggest = Math.max(biggest, Math.abs(rest[i][1] - rest[i - 1][1]));
		}
		expect(biggest).toBeLessThan(30);
	});

	it('takes an ordinary retarget mid-way (a fit) in slope and offset too', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.folding(() => s.domain.set([0, 100], { instant: true }));
		frames(s, 20);
		s.domain.set([0, 150]); // not a unit change
		expect(s.domain.target).toEqual([0, 150]);
		const run = frames(s);
		expect(run[run.length - 1][1]).toBeCloseTo(150, 6);
	});

	it('on a log scale, moves linearly in log space', () => {
		const s = onScreen(new LogScaleState('y', [1, 1000]), 1, 1000);
		s.folding(() => s.domain.set([1, 10], { instant: true }));
		const run = frames(s);
		const p = springProgress(run.length);
		expect(stray(run, p, [1, 1000], [1, 10], [2, 5, 8], Math.log)).toBeLessThan(1e-4);
		expect(run[run.length - 1][1]).toBeCloseTo(10, 6);
	});

	it('still snaps an instant change outside folding()', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.domain.set([0, 100], { instant: true });
		expect(s.domain.current[1]).toBe(100);
		expect(s.isAtRest()).toBe(true);
	});

	it('takes a pan mid-way without a jump, and ends where the pan left it', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.folding(() => s.domain.set([0, 100], { instant: true }));
		const before = frames(s, 15);
		const [lo, hi] = before[before.length - 1];
		// A 500 px plot, dragged 100 px: a fifth of the drawn domain.
		s.setPanContext({ screenToDataRatio: (hi - lo) / 500, axis: 'y', initialScreenPos: 0 });
		s.updatePanPosition(0, 100);
		const target = s.domain.target;
		s.updateRenderState(0);
		// The pan retargets; it moves nothing in its own frame.
		expect(s.domain.current[0]).toBeCloseTo(lo, 6);
		expect(s.domain.current[1]).toBeCloseTo(hi, 6);
		s.endPan();
		const run = frames(s);
		const end = run[run.length - 1];
		expect(end[0]).toBeCloseTo(target[0], 4);
		expect(end[1]).toBeCloseTo(target[1], 4);
		let biggest = 0;
		for (let i = 1; i < run.length; i++) {
			biggest = Math.max(biggest, Math.abs(run[i][1] - run[i - 1][1]));
		}
		expect(biggest).toBeLessThan(30);
	});

	it('carries a moving spring’s velocity into the tween: no jump, no stall', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.domain.set([0, 300]); // an ordinary spring, under way
		const moving = frames(s, 12);
		const at50 = (d: [number, number]) => at(50, d);
		const last = moving[moving.length - 1];
		const vBefore = at50(last) - at50(moving[moving.length - 2]);
		s.folding(() => s.domain.set([0, 250], { instant: true }));
		s.updateRenderState(0);
		// Same position in the takeover frame...
		const [lo, hi] = s.domain.current;
		expect(at50([lo, hi])).toBeCloseTo(at50(last), 6);
		// ...and the next frame keeps going the same way at about the same speed.
		const next = frames(s, 1)[0];
		const vAfter = at50(next) - at50(last);
		expect(Math.sign(vAfter)).toBe(Math.sign(vBefore));
		expect(vAfter / vBefore).toBeGreaterThan(0.5);
		expect(vAfter / vBefore).toBeLessThan(1.5);
	});

	it('stays finite against a fast-widening spring: a large zoom-out keeps a positive width', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.domain.set([0, 1e5]); // widening fast
		frames(s, 3);
		s.folding(() => s.domain.set([0, 1e6], { instant: true }));
		const run = frames(s);
		for (const [lo, hi] of run) {
			expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true);
			expect(hi - lo).toBeGreaterThan(0);
		}
		expect(run[run.length - 1][1]).toBeCloseTo(1e6, 0);
	});
});
