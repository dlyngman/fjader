/**
 * Distinct categorical fields take distinct colours by default: each field's
 * colours start after those of the fields declared before it on the same
 * palette, so species and island don't both start at tableau10's first colour.
 * A better default, not a guarantee.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScaleRegistry } from './ScaleRegistry.svelte';
import { ColorScaleState } from './ColorScaleState.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';
import { schemeTableau10 } from 'd3-scale-chromatic';

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => log.mockRestore());

function field(
	reg: ScaleRegistry,
	name: string,
	values: string[],
	config: Record<string, unknown> = {}
) {
	const scale = reg.getOrCreateScale(
		name,
		'color',
		{ type: 'ordinal', ...config },
		'chart-1'
	) as ColorScaleState;
	return {
		scale,
		load() {
			scale.setDomain(values);
			scale.setIdentity(new FieldIdentity(values));
		}
	};
}

const colours = (scale: ColorScaleState, values: string[]) => values.map((v) => scale.getColor(v));

describe('colour blocks per field', () => {
	it('a field’s colours start after the fields declared before it', () => {
		const reg = new ScaleRegistry();
		reg.declareColorField('species');
		reg.declareColorField('island');
		const species = field(reg, 'species', ['Adelie', 'Chinstrap', 'Gentoo']);
		const island = field(reg, 'island', ['Biscoe', 'Dream', 'Torgersen']);
		species.load();
		island.load();

		expect(colours(species.scale, ['Adelie', 'Chinstrap', 'Gentoo'])).toEqual(
			schemeTableau10.slice(0, 3)
		);
		expect(colours(island.scale, ['Biscoe', 'Dream', 'Torgersen'])).toEqual(
			schemeTableau10.slice(3, 6)
		);
	});

	it('the result does not depend on the order the categories arrive in', () => {
		const reg = new ScaleRegistry();
		reg.declareColorField('species');
		reg.declareColorField('island');
		const species = field(reg, 'species', ['Adelie', 'Chinstrap', 'Gentoo']);
		const island = field(reg, 'island', ['Biscoe', 'Dream', 'Torgersen']);
		island.load();
		species.load();

		expect(colours(species.scale, ['Adelie'])).toEqual([schemeTableau10[0]]);
		expect(colours(island.scale, ['Biscoe'])).toEqual([schemeTableau10[3]]);
	});

	it('an explicit range opts a field out, and it takes no block', () => {
		const reg = new ScaleRegistry();
		reg.declareColorField('species');
		reg.declareColorField('island');
		const species = field(reg, 'species', ['Adelie', 'Chinstrap', 'Gentoo'], {
			range: ['#111111', '#222222', '#333333']
		});
		const island = field(reg, 'island', ['Biscoe', 'Dream', 'Torgersen']);
		species.load();
		island.load();

		expect(colours(species.scale, ['Adelie'])).toEqual(['#111111']);
		expect(colours(island.scale, ['Biscoe'])).toEqual([schemeTableau10[0]]);
	});

	it('a field with more categories than the palette cycles on its own', () => {
		const reg = new ScaleRegistry();
		reg.declareColorField('carrier');
		reg.declareColorField('island');
		const many = Array.from({ length: 12 }, (_, i) => `c${i}`);
		const carrier = field(reg, 'carrier', many);
		const island = field(reg, 'island', ['Biscoe', 'Dream']);
		carrier.load();
		island.load();

		expect(colours(carrier.scale, ['c0'])).toEqual([schemeTableau10[0]]);
		expect(colours(island.scale, ['Biscoe'])).toEqual([schemeTableau10[0]]);
	});

	it('a field no mark declared (a line’s series) takes no part', () => {
		const reg = new ScaleRegistry();
		reg.declareColorField('island');
		const series = field(reg, 'carrier', ['AA', 'UA']);
		const island = field(reg, 'island', ['Biscoe', 'Dream']);
		series.load();
		island.load();

		expect(colours(island.scale, ['Biscoe'])).toEqual([schemeTableau10[0]]);
	});

	it('a replaced scale for the same field gets the same colours back', () => {
		const reg = new ScaleRegistry();
		reg.declareColorField('species');
		reg.declareColorField('island');
		field(reg, 'species', ['Adelie', 'Chinstrap', 'Gentoo']).load();
		const first = field(reg, 'island', ['Biscoe', 'Dream']);
		first.load();
		reg.removeChartUsage('chart-1');

		reg.declareColorField('species');
		reg.declareColorField('island');
		field(reg, 'species', ['Adelie', 'Chinstrap', 'Gentoo']).load();
		const again = field(reg, 'island', ['Biscoe', 'Dream']);
		again.load();

		expect(colours(again.scale, ['Biscoe'])).toEqual([schemeTableau10[3]]);
	});
});
