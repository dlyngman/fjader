import { describe, it, expect } from 'vitest';
import { inferLegendScale } from './infer-legend-scale';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';

const scale = (field: string) => ({ field }) as ColorScaleState;

describe('inferLegendScale', () => {
	it("takes the chart's one color scale", () => {
		const species = scale('species');
		expect(inferLegendScale([species])).toEqual({ scale: species, ambiguous: null });
	});

	it('takes none when the chart colors by several, naming them', () => {
		expect(inferLegendScale([scale('species'), scale('island')])).toEqual({
			scale: null,
			ambiguous: ['species', 'island']
		});
	});

	it('takes none, quietly, when the chart colors by nothing', () => {
		expect(inferLegendScale([])).toEqual({ scale: null, ambiguous: null });
	});
});
