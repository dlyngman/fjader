/**
 * The registry's refcount, and the holder it could not see (§27.2).
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
