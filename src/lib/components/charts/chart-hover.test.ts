import { describe, it, expect } from 'vitest';
import { ChartHover } from './ChartHover.svelte';

describe('ChartHover', () => {
	it('is hovered while the pointer is over any cell', () => {
		const h = new ChartHover();
		expect(h.hovered).toBe(false);
		h.set('a', true);
		h.set('b', true);
		h.set('a', false);
		expect(h.hovered).toBe(true);
		h.set('b', false);
		expect(h.hovered).toBe(false);
	});
});
