import { describe, it, expect } from 'vitest';
import { FilterGroup } from '$lib/query-engine/FilterGroup.svelte';
import { BandRegistrations } from './band-registrations';

const chartMarks = () => new Set(['mark-chart']);

/** A Toggle declared on `declared`, with band-label registrations on a real FilterGroup. */
function setup(declared = 'category') {
	const group = new FilterGroup();
	const bands = new BandRegistrations(
		(field) => group.getOrCreateToggle(field).register({ excludeMarkIds: chartMarks }),
		(field) => field === declared
	);
	return { group, bands };
}

describe('BandRegistrations', () => {
	it('registers each axis’s band field, but not the declared field', () => {
		const { bands } = setup();
		bands.sync({ x: 'region', y: 'category' });

		expect(bands.entries().map(([field]) => field)).toEqual(['region']);
		expect(bands.handleFor('region')).not.toBeNull();
		expect(bands.handleFor('category')).toBeNull();
	});

	it('keeps a label selection while the axis has no band scale', () => {
		const { group, bands } = setup();
		bands.sync({ x: 'region', y: null });
		bands.handleFor('region')!.toggle(['North'], false);

		// The band scale is being rebuilt (a reload, a reassignment in progress).
		bands.sync({ x: null, y: null });
		expect(group.selection.isActive('toggle-region')).toBe(true);
		expect(bands.handleFor('region')).not.toBeNull();

		bands.sync({ x: 'region', y: null });
		expect(group.getOrCreateToggle('region').values).toEqual(new Set(['North']));
	});

	it('clears a label selection when its axis switches to another field', () => {
		const { group, bands } = setup();
		bands.sync({ x: 'region', y: null });
		bands.handleFor('region')!.toggle(['North'], false);

		bands.sync({ x: 'carrier', y: null });
		expect(group.selection.isActive('toggle-region')).toBe(false);
		expect(group.getOrCreateToggle('region').active).toBe(false);
		expect(bands.handleFor('carrier')).not.toBeNull();
	});

	it('keeps the selection when a legend still holds the old field', () => {
		const { group, bands } = setup();
		const legend = group.getOrCreateToggle('region').register({ excludeMarkIds: () => new Set() });
		bands.sync({ x: 'region', y: null });
		legend.toggle(['North'], false);

		bands.sync({ x: 'carrier', y: null });
		expect(group.selection.isActive('toggle-region')).toBe(true);
	});

	it('destroy releases every registration', () => {
		const { group, bands } = setup();
		bands.sync({ x: 'region', y: 'carrier' });
		bands.handleFor('carrier')!.toggle(['UA'], false);

		bands.destroy();
		expect(bands.entries()).toEqual([]);
		expect(group.selection.isActive('toggle-carrier')).toBe(false);
	});
});
