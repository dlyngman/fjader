import { describe, it, expect } from 'vitest';
import { AutoBinNode } from '$lib/sql/bin';
import type { BinPadding } from '$lib/types';
import { binRowsMoved, binSpecKey, heldCoversView, isRebin, rebinTweens } from './rebin';

/** The spec a mark's parts carry for one bin channel, as the lifecycle builds it. */
function spec(
	node: AutoBinNode,
	info: Record<string, { min: number; max: number; type?: string }>,
	scaleType: string,
	multiplier = 1,
	t0: number | null = null
): Record<string, BinPadding> {
	const padding = node.padding(info, scaleType, null, multiplier, t0);
	if (!padding) throw new Error('no padding');
	return { x1: padding };
}

const numeric = { v: { min: 0, max: 100 } };
const days = { ts: { min: Date.UTC(2023, 0, 1), max: Date.UTC(2024, 11, 31), type: 'date' } };
const T0 = Date.UTC(2023, 0, 1) / 1000;

describe('rebin detection by bin spec', () => {
	it('is not a rebin for the same bins, however the rows differ', () => {
		// Two results of the same parts: a filter changes rows, not the spec.
		const a = binSpecKey(spec(new AutoBinNode('v', { steps: 30 }), numeric, 'linear'));
		const b = binSpecKey(spec(new AutoBinNode('v', { steps: 30 }), numeric, 'linear'));
		expect(a).toBe(b);
		expect(isRebin(a, b)).toBe(false);
	});

	it('is a rebin when the step changes', () => {
		const a = binSpecKey(spec(new AutoBinNode('v', { steps: 30 }), numeric, 'linear'));
		const b = binSpecKey(spec(new AutoBinNode('v', { steps: 30 }), numeric, 'linear', 2));
		expect(isRebin(a, b)).toBe(true);
	});

	it("catches a user's step scaled by one shift+scroll notch (3.5%)", () => {
		const node = new AutoBinNode('v', { step: 2 });
		const a = binSpecKey(spec(node, numeric, 'linear', 1));
		const b = binSpecKey(spec(node, numeric, 'linear', 1.035));
		expect(isRebin(a, b)).toBe(true);
	});

	it('catches a whole-unit interval moving by one unit (10 to 9 days)', () => {
		const node = new AutoBinNode('ts', { interval: 'day', step: 10 });
		const a = binSpecKey(spec(node, days, 'time', 1, T0));
		const b = binSpecKey(spec(node, days, 'time', 1.1, T0));
		expect(isRebin(a, b)).toBe(true);
	});

	it('is never the first result, and never without a spec on both sides', () => {
		const a = binSpecKey(spec(new AutoBinNode('v', { steps: 30 }), numeric, 'linear'));
		expect(isRebin(null, a)).toBe(false);
		expect(isRebin(a, null)).toBe(false);
		expect(binSpecKey(null)).toBeNull();
	});
});

describe('rows moved: a rebin, or a window moved over the same bins', () => {
	it('a rebin moves the rows; nothing to compare with does not', () => {
		expect(binRowsMoved('a', null, 'b', null)).toBe(true);
		expect(binRowsMoved(null, null, 'b', null)).toBe(false);
		expect(binRowsMoved('a', null, null, null)).toBe(false);
	});

	it('the same bins over a moved window move the rows, though it is no rebin', () => {
		expect(binRowsMoved('a', [0, 10], 'a', [5, 15])).toBe(true);
		expect(isRebin('a', 'a')).toBe(false);
	});

	it('the same window, by value, does not; none is the whole extent', () => {
		expect(binRowsMoved('a', [0, 10], 'a', [0, 10])).toBe(false);
		expect(binRowsMoved('a', null, 'a', null)).toBe(false);
		expect(binRowsMoved('a', null, 'a', [0, 10])).toBe(true);
		expect(binRowsMoved('a', [0, 10], 'a', null)).toBe(true);
	});
});

describe('how a rebin moves its value axis', () => {
	it('tweens: every consumer follows the render domain, the bars ride it', () => {
		expect(rebinTweens(false, false)).toBe(true);
	});

	it('a catch-up does not tween: its bars land at once, so the axis lands with them', () => {
		// A tween under landed bars would leave them at half or double height.
		expect(rebinTweens(false, true)).toBe(false);
	});

	it('an axis the user zoomed is not overridden', () => {
		expect(rebinTweens(true, false)).toBe(false);
		expect(rebinTweens(true, true)).toBe(false);
	});
});

describe('whether a hold’s rows cover what the new rows draw in view', () => {
	it('covers an unwindowed histogram whose axis runs past the data', () => {
		// Data 0–100 at both steps; the view is padded to −10–110.
		expect(heldCoversView([0, 100], [0, 100], [-10, 110], 5)).toBe(true);
	});

	it('allows the last new bin to reach one step past the held rows', () => {
		// Held step 2 ends at 1500; the new step-5 bin ends at 1505.
		expect(heldCoversView([-60, 1500], [-60, 1505], [-100, 1600], 5)).toBe(true);
	});

	it('refuses a zoom out past a window’s margin: new bars in view the held rows lack', () => {
		// Held window 40–60; the new rows (and the view) run 0–100.
		expect(heldCoversView([40, 60], [0, 100], [10, 90], 5)).toBe(false);
	});

	it('ignores new rows outside the view', () => {
		expect(heldCoversView([40, 60], [0, 100], [45, 55], 5)).toBe(true);
	});
});
