import { describe, it, expect } from 'vitest';
import { AutoBinNode } from '$lib/sql/bin';
import type { BinPadding } from '$lib/types';
import { binSpecKey, isRebin } from './rebin';

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
