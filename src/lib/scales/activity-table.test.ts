import { describe, it, expect } from 'vitest';
import { ActivityTable, selectionOpacity, DEFAULT_INACTIVE_OPACITY } from './ActivityTable';

// The table every categorical scale will own for selection dimming. These drive
// it directly, with a stand-in loop, the way slot-transition.test.ts drives
// SlotTransition.

const loop = { addAnimatedSource: () => {}, removeAnimatedSource: () => {} };
const charts = () => ['chart-a'];

function table(count = 3, frames: number[] = []) {
	const a = new ActivityTable(loop, { charts, onFrame: () => frames.push(a.t) });
	a.resize(count);
	return a;
}

function stepTo(a: ActivityTable, frames: number) {
	for (let i = 0; i < frames; i++) {
		a.clock.step();
		a.clock.updateRenderState(0);
	}
}

function settle(a: ActivityTable) {
	let n = 0;
	while (!a.clock.isAtRest() && n++ < 5000) stepTo(a, 1);
	a.clock._markAtRest();
}

const activity = (a: ActivityTable) => [...Array(a.count).keys()].map((id) => a.activityOf(id));

describe('ActivityTable', () => {
	it('starts with every id active and nothing animating', () => {
		const a = table();
		expect(activity(a)).toEqual([1, 1, 1]);
		expect(a.isAnimating).toBe(false);
	});

	it('names its charts to the loop, so a fade is redrawn', () => {
		const a = table();
		expect(a.clock._affectedChartsArray).toEqual(['chart-a']);
	});

	it('fades unselected ids out, all on one t, and lands exactly on 0 and 1', () => {
		const a = table();
		a.setActive([1]);
		expect(a.isAnimating).toBe(true);
		expect(activity(a)).toEqual([1, 1, 1]);

		stepTo(a, 20);
		const [first, selected, third] = activity(a);
		expect(first).toBeLessThan(1);
		expect(first).toBeGreaterThan(0);
		expect(third).toBeCloseTo(first, 6);
		expect(selected).toBe(1);

		settle(a);
		expect(a.t).toBe(1);
		expect(Array.from(a.from)).toEqual([0, 1, 0]);
		expect(Array.from(a.to)).toEqual([0, 1, 0]);
	});

	it('fades everything back in on clear', () => {
		const a = table();
		a.setActive([0]);
		settle(a);
		a.clear();
		stepTo(a, 20);
		expect(a.activityOf(1)).toBeGreaterThan(0);
		expect(a.activityOf(1)).toBeLessThan(1);
		settle(a);
		expect(activity(a)).toEqual([1, 1, 1]);
	});

	it('continues from where each id is when a click lands mid-fade', () => {
		const a = table();
		a.setActive([0]);
		stepTo(a, 20);
		const midway = a.activityOf(1);

		// Selecting id 1 now reverses its fade: it must start from where it got to.
		a.setActive([0, 1]);
		expect(a.t).toBe(0);
		expect(a.activityOf(1)).toBeCloseTo(midway, 6);
		expect(a.activityOf(2)).toBeCloseTo(midway, 6);
		settle(a);
		expect(activity(a)).toEqual([1, 1, 0]);
	});

	it('does nothing when the selection is the one already headed to', () => {
		const a = table();
		a.setActive([2]);
		stepTo(a, 10);
		const version = a.version;
		const t = a.t;

		a.setActive([2]);
		expect(a.version).toBe(version);
		expect(a.t).toBe(t);

		settle(a);
		const atRest = a.version;
		a.setActive(new Set([2]));
		expect(a.version).toBe(atRest);
		expect(a.isAnimating).toBe(false);
	});

	it('bumps its version on every change the packer must upload', () => {
		const a = table();
		const v0 = a.version;
		a.setActive([0]);
		expect(a.version).toBeGreaterThan(v0);
		const v1 = a.version;
		settle(a);
		expect(a.version).toBeGreaterThan(v1);
		const v2 = a.version;
		a.resize(4);
		expect(a.version).toBeGreaterThan(v2);
	});

	it('ignores ids outside the table, and answers 1 for them', () => {
		const a = table();
		a.setActive([1, 7, -1]);
		settle(a);
		expect(activity(a)).toEqual([0, 1, 0]);
		expect(a.activityOf(7)).toBe(1);
		expect(a.activityOf(-1)).toBe(1);
	});

	it('gives a new id the state of the selection: active with none, inactive with one', () => {
		const a = table(2);
		a.resize(3);
		expect(a.activityOf(2)).toBe(1);

		a.setActive([0]);
		settle(a);
		a.resize(4);
		expect(a.activityOf(3)).toBe(0);

		a.clear();
		settle(a);
		a.resize(5);
		expect(a.activityOf(4)).toBe(1);
	});

	it('starts new ids at a selection the table has not seen, rather than fading to it', () => {
		const a = table(0);
		a.resize(3, [1]);
		expect(activity(a)).toEqual([0, 1, 0]);
		expect(Array.from(a.from)).toEqual([0, 1, 0]);

		const b = table(0);
		b.resize(2, null);
		expect(Array.from(b.from)).toEqual([1, 1]);
	});

	it('drops every id on resize(0)', () => {
		const a = table();
		a.setActive([0]);
		settle(a);
		a.resize(0);
		expect(a.count).toBe(0);
		expect(a.activityOf(1)).toBe(1);
	});

	it('keeps an existing fade across a grow, and truncates on a shrink', () => {
		const a = table();
		a.setActive([0]);
		stepTo(a, 20);
		const midway = a.activityOf(1);

		a.resize(4);
		expect(a.activityOf(1)).toBeCloseTo(midway, 6);
		expect(a.isAnimating).toBe(true);

		a.resize(2);
		expect(a.count).toBe(2);
		settle(a);
		expect(activity(a)).toEqual([1, 0]);
	});

	it('reports every driven frame, and once more at rest with t exactly 1', () => {
		const frames: number[] = [];
		const a = table(3, frames);
		a.setActive([0]);
		stepTo(a, 3);
		expect(frames).toHaveLength(3);
		settle(a);
		expect(frames.at(-1)).toBe(1);
	});

	it('lands at once with no loop', () => {
		const a = new ActivityTable(null, { charts });
		a.resize(3);
		a.setActive([2]);
		expect(a.isAnimating).toBe(false);
		expect(a.t).toBe(1);
		expect(activity(a)).toEqual([0, 0, 1]);
	});

	it('lands at once after destroy, rather than animating for nobody', () => {
		const a = table();
		a.destroy();
		a.setActive([1]);
		expect(a.isAnimating).toBe(false);
		expect(activity(a)).toEqual([0, 1, 0]);
	});
});

describe('selectionOpacity', () => {
	it('maps activity to opacity the way the shaders do', () => {
		// The shaders compute 1 - dimStrength * (1 - activity), with
		// dimStrength = 1 - inactiveOpacity; this must agree with it.
		const dim = (activity: number, inactive: number) => 1 - (1 - inactive) * (1 - activity);
		for (const inactive of [DEFAULT_INACTIVE_OPACITY, 0, 0.6, 1]) {
			for (const activity of [0, 0.3, 1]) {
				expect(selectionOpacity(activity, inactive)).toBeCloseTo(dim(activity, inactive), 6);
			}
		}
		expect(selectionOpacity(0)).toBe(DEFAULT_INACTIVE_OPACITY);
		expect(selectionOpacity(1)).toBe(1);
	});
});
