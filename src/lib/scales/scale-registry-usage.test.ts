/**
 * The registry's refcount, and the holder it could not see.
 *
 * A scale stays alive while at least one chart id claims it. Until
 * `registerChart` existed, the count could only be incremented by the call that
 * CREATED the scale, so a component handed an existing instance by reference
 * was invisible to it. A faceted container is exactly that shape: it obtains
 * the facet scale under its own chart id, hands the object to its cells, then
 * stops being a chart — and the eviction that follows destroys a scale every
 * cell is still reading.
 */

import { describe, it, expect } from 'vitest';
import { ScaleRegistry } from './ScaleRegistry.svelte';
import type { BandScaleState } from './BandScaleState.svelte';
import type { ColorScaleState } from './ColorScaleState.svelte';

function registry() {
	// No GPU coordinator: this exercises the refcount only, which is pure
	// bookkeeping and never reaches the device.
	return new ScaleRegistry();
}

function band(reg: ScaleRegistry, name: string, chartId: string) {
	return reg.getOrCreateScale(name, 'band', { sourceField: name }, chartId) as BandScaleState;
}

describe('ScaleRegistry chart usage', () => {
	it('keeps a scale alive while a second holder claims it', () => {
		const reg = registry();
		const scale = band(reg, 'species', 'chart-1');

		reg.registerChart(scale, 'chart-1-fx-owner');
		reg.deregisterChart(scale, 'chart-1');

		// The creating chart is gone; the holder is not.
		expect(scale.isDestroyed).toBe(false);
		expect(reg.findScale('species', 'band', { sourceField: 'species' })).toBe(scale);
	});

	it('destroys it once the last holder leaves', () => {
		const reg = registry();
		const scale = band(reg, 'island', 'chart-1');

		reg.registerChart(scale, 'chart-1-fx-owner');
		reg.deregisterChart(scale, 'chart-1');
		reg.deregisterChart(scale, 'chart-1-fx-owner');

		expect(scale.isDestroyed).toBe(true);
	});

	it('is idempotent, so a holder cannot inflate the count', () => {
		const reg = registry();
		const scale = band(reg, 'sex', 'chart-1');

		reg.registerChart(scale, 'holder');
		reg.registerChart(scale, 'holder');
		reg.deregisterChart(scale, 'chart-1');
		// One deregister must balance any number of registers for the same id.
		reg.deregisterChart(scale, 'holder');

		expect(scale.isDestroyed).toBe(true);
	});

	it('ignores an empty scale or chart id rather than throwing', () => {
		const reg = registry();
		const scale = band(reg, 'year', 'chart-1');
		expect(() => reg.registerChart(scale, '')).not.toThrow();
		expect(() => reg.registerChart(null as never, 'x')).not.toThrow();
		expect(scale.isDestroyed).toBe(false);
	});
});

describe('ScaleRegistry band padding', () => {
	it('lets `padding` stand in for both halves', () => {
		// It could not, and silently: inner and outer were defaulted here
		// unconditionally, so the scale's own `#paddingInner ?? #padding`
		// fallback was unreachable and a mark's `padding` prop did nothing.
		const reg = registry();
		const scale = reg.getOrCreateScale(
			'species',
			'band',
			{ sourceField: 'species', padding: 0.3 },
			'chart-1'
		) as BandScaleState;

		const config = scale.getConfig();
		expect(config.paddingInner).toBe(0.3);
		expect(config.paddingOuter).toBe(0.3);
	});

	it('lets an explicit half win over the shorthand', () => {
		const reg = registry();
		const scale = reg.getOrCreateScale(
			'island',
			'band',
			{ sourceField: 'island', padding: 0.3, paddingOuter: 0 },
			'chart-1'
		) as BandScaleState;

		const config = scale.getConfig();
		expect(config.paddingInner).toBe(0.3);
		expect(config.paddingOuter).toBe(0);
	});

	it('keeps a point scale at paddingInner 1, where `padding` is the outer one', () => {
		// A point scale's bands have no width by definition, so the shorthand
		// cannot be allowed to reach the inner half.
		const reg = registry();
		const scale = reg.getOrCreateScale(
			'year',
			'point',
			{ sourceField: 'year', padding: 0.3 },
			'chart-1'
		) as BandScaleState;

		const config = scale.getConfig();
		expect(config.paddingInner).toBe(1);
		expect(config.paddingOuter).toBe(0.3);
	});
});

describe('ScaleRegistry color use (what a Legend infers from)', () => {
	function color(reg: ScaleRegistry, name: string, chartId: string) {
		return reg.getOrCreateScale(name, 'color', { type: 'ordinal' }, chartId) as ColorScaleState;
	}
	const scalesOf = (reg: ScaleRegistry, chartId: string) =>
		reg.colorScalesOf(chartId).map((u) => u.scale);

	it('lists the scales a chart colors by, once however many channels share one', () => {
		const reg = registry();
		const species = color(reg, 'species', 'chart-1');
		// fill and stroke on the same field: one scale, used twice.
		reg.useAsColor(species, 'chart-1');
		reg.useAsColor(species, 'chart-1');
		const island = color(reg, 'island', 'chart-2');
		reg.useAsColor(island, 'chart-2', true);

		expect(scalesOf(reg, 'chart-1')).toEqual([species]);
		expect(reg.colorScalesOf('chart-2')).toEqual([{ scale: island, expression: true }]);
	});

	it("leaves out a line's series scale, which groups without coloring", () => {
		const reg = registry();
		// MarkSeries obtains an ordinal color scale but never calls useAsColor.
		color(reg, 'carrier', 'chart-1');
		const species = color(reg, 'species', 'chart-1');
		reg.useAsColor(species, 'chart-1');

		expect(scalesOf(reg, 'chart-1')).toEqual([species]);
	});

	it('a mark switching field leaves one candidate', () => {
		const reg = registry();
		const release = reg.useAsColor(color(reg, 'species', 'chart-1'), 'chart-1');
		// MarkColor's effect re-runs: its cleanup releases, then it uses the new scale.
		release();
		const island = color(reg, 'island', 'chart-1');
		reg.useAsColor(island, 'chart-1');

		expect(scalesOf(reg, 'chart-1')).toEqual([island]);
	});

	it('a mark removed (an {#if}) leaves none; releasing twice changes nothing', () => {
		const reg = registry();
		const species = color(reg, 'species', 'chart-1');
		const release = reg.useAsColor(species, 'chart-1');
		release();
		expect(scalesOf(reg, 'chart-1')).toEqual([]);

		reg.useAsColor(species, 'chart-1');
		release();
		expect(scalesOf(reg, 'chart-1')).toEqual([species]);
	});

	it('two marks on one scale, one removed: the chart still colors by it', () => {
		const reg = registry();
		const species = color(reg, 'species', 'chart-1');
		const first = reg.useAsColor(species, 'chart-1');
		reg.useAsColor(species, 'chart-1');
		first();

		expect(scalesOf(reg, 'chart-1')).toEqual([species]);
	});

	it('removeChartUsage keeps color use while the scale lives, and drops it with the scale', () => {
		const reg = registry();
		const species = color(reg, 'species', 'chart-1');
		color(reg, 'species', 'chart-2');
		const release = reg.useAsColor(species, 'chart-1');

		// A scales rebuild: the chart's usage goes, its marks still color by it.
		reg.removeChartUsage('chart-1');
		expect(species.isDestroyed).toBe(false);
		expect(scalesOf(reg, 'chart-1')).toEqual([species]);

		// The last chart leaves: the scale is destroyed, and its color use with it.
		reg.removeChartUsage('chart-2');
		expect(species.isDestroyed).toBe(true);
		expect(scalesOf(reg, 'chart-1')).toEqual([]);
		// The mark's later release finds nothing to drop.
		expect(() => release()).not.toThrow();
		expect(scalesOf(reg, 'chart-1')).toEqual([]);
	});
});
