import { describe, it, expect } from 'vitest';
import { drawsThisFrame } from './morph-gate';

const charts = (drawn: Record<string, number>) =>
	new Map(Object.entries(drawn).map(([id, frame]) => [id, { _lastRenderFrame: frame }]));

describe('drawsThisFrame', () => {
	it('is true when one of the charts drew in this frame', () => {
		const registered = charts({ a: 7, b: 6 });
		expect(drawsThisFrame(['a'], registered, 7)).toBe(true);
		// A facet grid: any cell is enough.
		expect(drawsThisFrame(['b', 'a'], registered, 7)).toBe(true);
	});

	it('is false when none did: at rest, or off screen', () => {
		const registered = charts({ a: 6, b: -1 });
		expect(drawsThisFrame(['a', 'b'], registered, 7)).toBe(false);
	});

	it('is false for a chart that has not registered: it cannot draw yet', () => {
		// A faceted mark before its cells exist names its parent, which has no canvas.
		expect(drawsThisFrame(['parent'], charts({ a: 7 }), 7)).toBe(false);
	});

	it('is true for a mark that names no chart, which nothing else would ever run', () => {
		expect(drawsThisFrame([], charts({ a: 6 }), 7)).toBe(true);
	});
});
