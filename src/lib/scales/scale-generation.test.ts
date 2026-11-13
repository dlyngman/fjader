import { describe, it, expect } from 'vitest';
import { foldScaleIds, type ScaleIds } from './ScaleGeneration.svelte';

/** Fold a sequence of (ChartScales, x id, y id), as the chart's derived sees them. */
function count(steps: [unknown, string | undefined, string | undefined][]): number {
	const seen: ScaleIds = { owner: undefined, x: undefined, y: undefined, count: 0 };
	for (const [owner, x, y] of steps) foldScaleIds(seen, owner, x, y);
	return seen.count;
}

const A = { name: 'ChartScales A' };
const B = { name: 'ChartScales B' };

describe('foldScaleIds (ScaleGeneration)', () => {
	it('does not count the first resolution, which every mark causes itself', () => {
		expect(
			count([
				[A, undefined, undefined],
				[A, 'x1', 'y1']
			])
		).toBe(0);
	});

	it('counts a defined scale replaced by another, on either axis', () => {
		expect(
			count([
				[A, 'x1', 'y1'],
				[A, 'x2', 'y1'],
				[A, 'x2', 'y2'],
				[A, 'x2', 'y2']
			])
		).toBe(2);
	});

	it('counts a recreated ChartScales once, including its first resolution', () => {
		// A relabelled axis: the container builds B, which starts empty; marks
		// must rebuild to register with it, and its scales then resolve.
		expect(
			count([
				[A, 'x1', 'y1'],
				[B, undefined, undefined],
				[B, 'x2', 'y2'],
				[B, 'x2', 'y2']
			])
		).toBe(1);
	});

	it('does not count the first ChartScales appearing', () => {
		expect(
			count([
				[null, undefined, undefined],
				[A, undefined, undefined],
				[A, 'x1', 'y1']
			])
		).toBe(0);
	});
});
