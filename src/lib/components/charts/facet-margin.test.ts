import { describe, it, expect } from 'vitest';
import { hasTopYTitle } from './facet-margin';
import type { AxisSpec } from '../axes/axis-spec';

const axis = (spec: Partial<AxisSpec>): AxisSpec => ({
	id: 'a',
	side: 'left',
	ticksNumber: 5,
	tickFormat: null,
	title: true,
	titleAnchor: 'center',
	titleOffset: 32,
	titlePlacement: 'side',
	...spec
});

describe('hasTopYTitle', () => {
	it('is true for a left axis with its title on top', () => {
		expect(hasTopYTitle([axis({ side: 'bottom' }), axis({ titlePlacement: 'top' })])).toBe(true);
	});

	it('is false for a side title, a hidden title, or no left axis', () => {
		expect(hasTopYTitle([axis({})])).toBe(false);
		expect(hasTopYTitle([axis({ titlePlacement: 'top', title: false })])).toBe(false);
		expect(hasTopYTitle([axis({ side: 'bottom', titlePlacement: 'top' })])).toBe(false);
		expect(hasTopYTitle([])).toBe(false);
	});
});
