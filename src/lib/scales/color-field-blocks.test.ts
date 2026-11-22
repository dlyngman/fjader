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

describe('a field’s base reaches the GPU', () => {
	it('uploads the config again with a rank space that spans the base', () => {
		// The shader wraps a rank by the config's palette size. Left at the
		// field's own count (3), ranks 3..5 wrapped back to the first colours:
		// the legend and tooltips (CPU) were right, the points were not.
		const paletteSizes: number[] = [];
		const coordinator = {
			addAnimatedSource: () => {},
			removeAnimatedSource: () => {},
			writeColorConfig: (_slot: number, data: ArrayBufferLike) =>
				paletteSizes.push(new Uint32Array(data as ArrayBuffer)[4]),
			writeColorConfigSlotBase: () => {},
			writeColorPalette: () => {},
			writeColorRamp: () => {}
		};
		const registry = {
			allocateColorSlot: () => 0,
			allocatePaletteSlot: () => 0,
			allocateRampSlot: () => 0,
			releasePaletteSlot: () => {},
			invalidateChartsUsingScale: () => {},
			chartsUsing: () => ['chart-1']
		};
		const values = ['Biscoe', 'Dream', 'Torgersen'];
		const scale = new ColorScaleState(
			{ field: 'island', type: 'ordinal', scheme: 'tableau10', domain: values },
			registry as never,
			coordinator as never
		);
		scale.setIdentity(new FieldIdentity(values));
		expect(paletteSizes.at(-1)).toBe(3);

		scale.setRankBase(3);

		expect(paletteSizes.at(-1)).toBe(6);
		expect(Array.from(scale.slots.to as Float32Array)).toEqual([3, 4, 5]);
	});
});

describe('colour blocks: limits of the default', () => {
	it('a field placed late that does not fit cycles from 0, and the legend matches the GPU', () => {
		// Five 8-category fields on tableau10 (10 colours): only the first fits.
		// Every placed rank stays below the palette's length, so the shader's wrap
		// and the legend's agree for every value.
		const reg = new ScaleRegistry();
		const names = ['a', 'b', 'c', 'd', 'e'];
		for (const name of names) reg.declareColorField(name);
		const fields = names.map((name) => {
			const values = Array.from({ length: 8 }, (_, i) => `${name}${i}`);
			const f = field(reg, name, values);
			f.load();
			return { ...f, values };
		});
		for (const { scale, values } of fields) {
			const ranks = Array.from(scale.slots.to as Float32Array);
			for (let i = 0; i < values.length; i++) {
				expect(ranks[i]).toBeLessThan(10);
				expect(scale.getColor(values[i])).toBe(schemeTableau10[ranks[i] % 10]);
			}
		}
		expect(fields[1].scale.getColor('b0')).toBe(schemeTableau10[0]);
	});

	it('a field outgrowing its room keeps it: the fields after it do not move', () => {
		const reg = new ScaleRegistry();
		reg.declareColorField('species');
		reg.declareColorField('island');
		const species = field(reg, 'species', ['Adelie', 'Chinstrap', 'Gentoo']);
		const island = field(reg, 'island', ['Biscoe', 'Dream', 'Torgersen']);
		species.load();
		island.load();
		expect(island.scale.getColor('Biscoe')).toBe(schemeTableau10[3]);

		// species gains categories past what the palette has room for.
		const many = Array.from({ length: 12 }, (_, i) => `s${i}`);
		species.scale.setDomain(many);
		species.scale.setIdentity(new FieldIdentity(many));

		expect(island.scale.getColor('Biscoe')).toBe(schemeTableau10[3]);
	});

	it('a scheme change files the field under its new palette', () => {
		const reg = new ScaleRegistry();
		reg.declareColorField('species');
		reg.declareColorField('island');
		const species = field(reg, 'species', ['Adelie', 'Chinstrap', 'Gentoo']);
		const island = field(reg, 'island', ['Biscoe', 'Dream', 'Torgersen']);
		species.load();
		island.load();
		expect(island.scale.getColor('Biscoe')).toBe(schemeTableau10[3]);

		// species moves to another palette: island's no longer has to leave it room.
		species.scale.setScheme('set2');
		expect(island.scale.getColor('Biscoe')).toBe(schemeTableau10[0]);
	});

	it('a destroyed scale’s late identity changes nothing', () => {
		const reg = new ScaleRegistry();
		reg.declareColorField('species');
		reg.declareColorField('island');
		const species = field(reg, 'species', ['Adelie', 'Chinstrap', 'Gentoo']);
		const island = field(reg, 'island', ['Biscoe', 'Dream', 'Torgersen']);
		species.load();
		island.load();
		const before = island.scale.getColor('Biscoe');

		species.scale.destroy();
		const grown = ['Adelie', 'Chinstrap', 'Gentoo', 'Emperor'];
		species.scale.setDomain(grown);
		species.scale.setIdentity(new FieldIdentity(grown));

		expect(island.scale.getColor('Biscoe')).toBe(before);
	});
});
