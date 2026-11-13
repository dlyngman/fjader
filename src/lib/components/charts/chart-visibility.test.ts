import { describe, it, expect } from 'vitest';
import { ChartVisibility } from './ChartVisibility.svelte';

describe('ChartVisibility', () => {
	it('counts as visible before any cell reports', () => {
		expect(new ChartVisibility().visible).toBe(true);
	});

	it('is visible while any cell is (facets), and not once none is', () => {
		const v = new ChartVisibility();
		v.set('cell-1', false);
		v.set('cell-2', true);
		expect(v.visible).toBe(true);
		v.set('cell-2', false);
		expect(v.visible).toBe(false);
	});

	it('forgets a cell that unmounts', () => {
		const v = new ChartVisibility();
		v.set('cell-1', false);
		v.remove('cell-1');
		expect(v.visible).toBe(true);
	});
});
