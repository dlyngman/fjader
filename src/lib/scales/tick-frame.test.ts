import { describe, it, expect } from 'vitest';
import {
	LinearScaleState,
	FADE_SECONDS,
	fadeProgress,
	type TickEntry
} from './LinearScaleState.svelte';
import { DT } from '$lib/animation';
import { LogScaleState } from './LogScaleState.svelte';

/** A scale on screen: entered, at [lo, hi]. */
function onScreen<T extends LinearScaleState>(scale: T, lo: number, hi: number): T {
	scale.entered = true;
	scale.domain.set([lo, hi], { instant: true });
	return scale;
}

/** Advance `n` frames (360 Hz steps, rendered without extrapolation). */
function frames(scale: LinearScaleState, n: number): void {
	for (let i = 0; i < n; i++) {
		scale.step();
		scale.updateRenderState(0);
	}
}

const byValue = (frame: readonly TickEntry[]) =>
	new Map(frame.map((e) => [e.value, { position: e.position, alpha: e.alpha, target: e.target }]));
/** A frame's ticks by where they are drawn: value and place. */
const byTick = (frame: readonly TickEntry[]) =>
	new Map(frame.map((e) => [`${e.value}@${e.position.toFixed(6)}`, e]));
/** A frame's ticks of one set: the newest (`target`) or the older ones. */
const setOf = (frame: readonly TickEntry[], target: boolean) =>
	new Map(frame.filter((e) => e.target === target).map((e) => [e.value, e]));

describe('tickFrame', () => {
	it('at rest: getTicks at opacity 1, positioned along the plot', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		const frame = s.tickFrame(5);
		expect(frame.map((e) => e.value)).toEqual(s.getTicks(5));
		for (const e of frame) {
			expect(e.alpha).toBe(1);
			expect(e.position).toBeCloseTo(e.value / 700, 9);
		}
	});

	it('a discrete change: each set stays at its own pixels, only opacities move', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		const old = s.getTicks(5); // 0, 200, 400, 600
		s.discrete(() => s.domain.set([0, 100], { instant: true }));
		frames(s, 60);
		// The fade's own clock: 60 steps at 360 Hz into FADE_SECONDS.
		const p = (60 * DT) / FADE_SECONDS;
		expect(p).toBeGreaterThan(0.1);
		expect(p).toBeLessThan(0.9);
		const frame = s.tickFrame(5);
		const outgoing = setOf(frame, false);
		const incoming = setOf(frame, true);
		// The old set where [0, 700] put it, fading out. (100 is in both sets, at
		// two different pixels: two ticks.)
		for (const v of old.filter((v) => v !== 0)) {
			expect(outgoing.get(v)!.position).toBeCloseTo(v / 700, 9);
			expect(outgoing.get(v)!.alpha).toBeCloseTo(1 - fadeProgress(p), 9);
		}
		// The new set where [0, 100] puts it, fading in.
		for (const v of [20, 40, 60, 80, 100]) {
			expect(incoming.get(v)!.position).toBeCloseTo(v / 100, 9);
			expect(incoming.get(v)!.alpha).toBeCloseTo(fadeProgress(p), 9);
		}
		// 0 is in both, at the same pixel: one tick, fully drawn.
		expect(frame.filter((e) => e.value === 0)).toHaveLength(1);
		expect(incoming.get(0)!.alpha).toBeCloseTo(1, 9);
	});

	it('eases: flat at both ends, steep in the middle', () => {
		// Flat at the ends: a rebin restarting f barely moves anything at first.
		expect(fadeProgress(0.05)).toBeLessThan(0.002);
		expect(1 - fadeProgress(0.95)).toBeLessThan(0.002);
		// Less overlap than a linear fade away from the middle.
		expect(fadeProgress(0.3)).toBeLessThan(0.2);
		expect(fadeProgress(0.7)).toBeGreaterThan(0.8);
		expect(fadeProgress(0.5)).toBeCloseTo(0.5, 12);
	});

	it('keeps every opacity within [0, 1], all the way through', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.discrete(() => s.domain.set([0, 100], { instant: true }));
		for (let i = 0; i < 800 && s.crossfading; i++) {
			frames(s, 1);
			for (const e of s.tickFrame(5)) {
				expect(e.alpha).toBeGreaterThanOrEqual(0);
				expect(e.alpha).toBeLessThanOrEqual(1);
			}
		}
	});

	it('a retarget mid-way continues from the opacities on screen; a faded set leaves', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.discrete(() => s.domain.set([0, 100], { instant: true }));
		frames(s, 30);
		const before = byTick(s.tickFrame(5));
		s.discrete(() => s.domain.set([0, 20], { instant: true }));
		s.updateRenderState(0); // the same instant: f = 0 in the new segment
		const after = byTick(s.tickFrame(5));
		for (const [id, e] of before) {
			if (e.alpha > 0) expect(after.get(id)!.alpha).toBeCloseTo(e.alpha, 9);
		}
		// Three sets now: [0, 700]'s and [0, 100]'s fading, [0, 20]'s coming in.
		frames(s, 30);
		const third = byValue(s.tickFrame(5));
		expect(third.get(600)!.alpha).toBeGreaterThan(0);
		// [0, 100]'s set had barely started fading in (the deeper fade starts at
		// f = 0.3): if any of it is still drawn, it is on its way out.
		const middle = third.get(80);
		if (middle) expect(middle.target).toBe(false);
		expect(third.get(15)!.target).toBe(true);
		expect(third.get(15)!.position).toBeCloseTo(15 / 20, 9);
		// Run [0, 700]'s set out, then retarget again: it is gone, not frozen anew.
		frames(s, 2000);
		if (s.tween) {
			s.discrete(() => s.domain.set([0, 30], { instant: true }));
			frames(s, 1);
			expect(byValue(s.tickFrame(5)).has(600)).toBe(false);
		}
	});

	it('ends where rest begins: the target’s ticks at their pixels, fully drawn', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.discrete(() => s.domain.set([0, 100], { instant: true }));
		let last: readonly TickEntry[] = [];
		for (let i = 0; i < 5000 && s.crossfading; i++) {
			last = s.tickFrame(5);
			frames(s, 1);
		}
		const rest = s.tickFrame(5);
		expect(rest.map((e) => e.value)).toEqual(s.getTicks(5));
		for (const e of rest) expect(e.alpha).toBe(1);
		// The last crossfading frame: the target's set, fully drawn, where rest
		// draws it; the old set gone.
		const shown = last.filter((e) => e.alpha > 1e-3);
		expect(shown.map((e) => e.value)).toEqual(rest.map((e) => e.value));
		shown.forEach((e, i) => {
			expect(e.position).toBeCloseTo(rest[i].position, 3);
			expect(e.alpha).toBeCloseTo(1, 3);
		});
	});

	it('fades on its own clock: slower than the bars, and the scale animates until it ends', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.discrete(() => s.domain.set([0, 100], { instant: true }));
		// 100 ms in: the tween is well under way, the ticks have barely moved.
		frames(s, 36);
		expect(s.tween!.f).toBeGreaterThan(0.3);
		const fresh = s.tickFrame(5).filter((e) => e.target && e.value === 20);
		expect(fresh[0].alpha).toBeLessThan(0.2);
		// The fade ends FADE_SECONDS after the segment began, not with the tween.
		frames(s, Math.ceil(FADE_SECONDS / DT) - 36 - 2);
		expect(s.crossfading).toBe(true);
		expect(s.isAtRest()).toBe(false);
		for (let i = 0; i < 5000 && !s.isAtRest(); i++) frames(s, 1);
		expect(s.crossfading).toBe(false);
	});

	it('a gesture ends the crossfade at once: live ticks, fully drawn', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.discrete(() => s.domain.set([0, 100], { instant: true }));
		frames(s, 30);
		expect(s.tickFrame(5).some((e) => e.alpha < 1)).toBe(true);
		s.setPanContext({ screenToDataRatio: 1, axis: 'y', initialScreenPos: 0 });
		frames(s, 1);
		const frame = s.tickFrame(5);
		expect(frame.map((e) => e.value)).toEqual(s.getTicks(5));
		for (const e of frame) expect(e.alpha).toBe(1);
	});

	it('only a discrete change crossfades: an ordinary spring re-ticks live', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.domain.set([0, 100]);
		frames(s, 30);
		const frame = s.tickFrame(5);
		expect(frame.map((e) => e.value)).toEqual(s.getTicks(5));
		for (const e of frame) expect(e.alpha).toBe(1);
	});

	it('freezes a set per count: the axis and the grid may ask for different ones', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		s.discrete(() => s.domain.set([0, 100], { instant: true }));
		frames(s, 30);
		const five = s
			.tickFrame(5)
			.filter((e) => e.target)
			.map((e) => e.value);
		const ten = s
			.tickFrame(10)
			.filter((e) => e.target)
			.map((e) => e.value);
		expect(five).toEqual([0, 20, 40, 60, 80, 100]);
		expect(ten).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
	});

	it('on a log scale: each set by the scale’s own ticks, positioned in log space', () => {
		const s = onScreen(new LogScaleState('y', [1, 1000]), 1, 1000);
		s.discrete(() => s.domain.set([1, 10], { instant: true }));
		frames(s, 30);
		const frame = byValue(s.tickFrame(5));
		// 100 belongs to the old set, under [1, 1000]: two thirds of the way in log.
		expect(frame.get(100)!.position).toBeCloseTo(2 / 3, 6);
		expect(frame.get(100)!.target).toBe(false);
		// 5 belongs to the new set, under [1, 10].
		expect(frame.get(5)!.position).toBeCloseTo(Math.log(5) / Math.log(10), 6);
		expect(frame.get(5)!.target).toBe(true);
	});

	it('valueAt places a position under the domain drawn now', () => {
		const s = onScreen(new LinearScaleState('y'), 0, 700);
		expect(s.valueAt(0.5)).toBeCloseTo(350, 9);
		const log = onScreen(new LogScaleState('y', [1, 1000]), 1, 1000);
		expect(log.valueAt(2 / 3)).toBeCloseTo(100, 6);
	});
});
