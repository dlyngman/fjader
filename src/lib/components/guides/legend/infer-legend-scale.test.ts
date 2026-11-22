import { describe, it, expect } from 'vitest';
import { inferLegendScale } from './infer-legend-scale';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';

const use = (field: string, expression = false) => ({
	scale: { field } as ColorScaleState,
	expression
});

describe('inferLegendScale', () => {
	it("takes the chart's one color scale", () => {
		const species = use('species');
		expect(inferLegendScale([species])).toEqual({ scale: species.scale, warning: null });
	});

	it('takes none when the chart colors by several, naming each field once', () => {
		const several = inferLegendScale([use('species'), use('island')]);
		expect(several.scale).toBeNull();
		expect(several.warning).toContain('(species, island)');

		// An ordinal and a continuous scale on one field.
		const oneField = inferLegendScale([use('body_mass'), use('body_mass')]);
		expect(oneField.scale).toBeNull();
		expect(oneField.warning).toContain('(body_mass)');
	});

	it('takes none for a scale keyed by an expression, with a warning', () => {
		const avg = inferLegendScale([use('AVG("body_mass")', true)]);
		expect(avg.scale).toBeNull();
		expect(avg.warning).toContain('an expression');
	});

	it('takes none, quietly, when the chart colors by nothing', () => {
		expect(inferLegendScale([])).toEqual({ scale: null, warning: null });
	});
});
