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

describe('ChartVisibility.shownElsewhere', () => {
	const scale = {};
	function peers(using: string[], visible: string[]) {
		return {
			chartsUsing: () => using,
			isChartVisible: (id: string) => visible.includes(id)
		};
	}

	it('is true when another visible chart draws the scale', () => {
		const v = new ChartVisibility(peers(['own', 'other'], ['own', 'other']));
		v.set('own', true);
		expect(v.shownElsewhere(scale)).toBe(true);
	});

	it('leaves the chart’s own cells out, so a returning chart does not block itself', () => {
		const v = new ChartVisibility(peers(['own-1', 'own-2'], ['own-1', 'own-2']));
		v.set('own-1', true);
		v.set('own-2', false);
		expect(v.shownElsewhere(scale)).toBe(false);
	});

	it('is false when the other charts drawing it are off screen', () => {
		const v = new ChartVisibility(peers(['own', 'other'], ['own']));
		v.set('own', true);
		expect(v.shownElsewhere(scale)).toBe(false);
	});

	it('is false without peers (no coordinator)', () => {
		expect(new ChartVisibility().shownElsewhere(scale)).toBe(false);
	});
});
