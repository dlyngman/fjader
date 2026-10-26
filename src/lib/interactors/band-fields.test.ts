import { describe, it, expect } from 'vitest';
import { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import { bandFieldsOf } from './band-fields';

const band = (field: string) => new BandScaleState(field, [], { sourceField: field });

describe('bandFieldsOf', () => {
	it('lists each band axis’s field, without the declared field', () => {
		expect(bandFieldsOf([band('region'), band('category')], 'category')).toEqual(['region']);
	});

	it('lists a field shown on both axes once', () => {
		expect(bandFieldsOf([band('region'), band('region')], null)).toEqual(['region']);
	});

	it('gives the same set of fields when the axes swap, so no label registration remounts', () => {
		const region = band('region');
		const carrier = band('carrier');
		const before = new Set(bandFieldsOf([region, carrier], null));
		expect(new Set(bandFieldsOf([carrier, region], null))).toEqual(before);
	});

	it('keeps a field while its band scale instance stays, whatever scaleTypes says', () => {
		// A band mark re-running setup leaves the instance in place while its
		// requirement is briefly gone; only a replaced instance drops the field.
		const region = band('region');
		expect(bandFieldsOf([region, null], null)).toEqual(['region']);
		expect(bandFieldsOf([new LinearScaleState('region'), null], null)).toEqual([]);
	});
});
