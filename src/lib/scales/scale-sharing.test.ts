/**
 * Which charts share an axis scale (its domain, zoom and pan). Shared by
 * default: the same label, else the same column across tables. An aggregate
 * without a label is the chart's own. `xScale` names a group, or keeps the
 * axis to the chart (false).
 */
import { describe, it, expect } from 'vitest';
import { count } from '@uwdata/mosaic-sql';
import { ChartScales } from './ChartScales.svelte';
import { ScaleRegistry } from './ScaleRegistry.svelte';
import { SCALE_PRIORITIES } from './ScalePriorities';

const registry = new ScaleRegistry();
let charts = 0;

function chart(options: { xLabel?: string; xScale?: string | false } = {}) {
	return new ChartScales({
		gpuCoordinator: {} as never,
		scaleRegistry: registry,
		layout: { chartId: `chart-${++charts}` } as never,
		...options
	});
}

function onX(scales: ChartScales, column: unknown, markId = `m${charts}`) {
	scales.registerScaleType('x', 'linear', SCALE_PRIORITIES.PREFER, markId, {}, column as never);
	return scales.xScaleState;
}

describe('which charts share an axis', () => {
	it('the same label: shared, whatever the columns', () => {
		const a = onX(chart({ xLabel: 'Delay (min)' }), 'dep_delay');
		const b = onX(chart({ xLabel: 'Delay (min)' }), 'delay_min');
		expect(a).toBe(b);
	});

	it('no label, the same column: shared, across tables', () => {
		const a = onX(chart(), 'distance');
		const b = onX(chart(), 'distance');
		expect(a).toBe(b);
	});

	it('no label, an aggregate: each chart its own', () => {
		const a = onX(chart(), count());
		const b = onX(chart(), count());
		expect(a).not.toBe(b);
	});

	it('the same label on aggregates: shared, since the label says so', () => {
		const a = onX(chart({ xLabel: 'flights' }), count());
		const b = onX(chart({ xLabel: 'flights' }), count());
		expect(a).toBe(b);
	});

	it('a named group shares different columns and labels', () => {
		const a = onX(chart({ xLabel: 'departure', xScale: 'delays' }), 'dep_delay');
		const b = onX(chart({ xLabel: 'arrival', xScale: 'delays' }), 'arr_delay');
		expect(a).toBe(b);
	});

	it('xScale={false}: its own, even with the same label', () => {
		const a = onX(chart({ xLabel: 'price' }), 'price');
		const b = onX(chart({ xLabel: 'price', xScale: false }), 'price');
		expect(a).not.toBe(b);
	});
});
