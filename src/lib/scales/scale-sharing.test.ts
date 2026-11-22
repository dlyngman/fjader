/**
 * Which charts share an axis scale (its domain, zoom and pan). Shared by
 * default: the same label, else the same column across tables. An aggregate
 * without a label is the chart's own. `xScale` names a group, or keeps the
 * axis to the chart (false).
 */
import { describe, it, expect, vi } from 'vitest';
import { column, count, dateMonthDay, sql, sum } from '@uwdata/mosaic-sql';
import { bin } from '$lib/sql/bin';
import { ChartScales } from './ChartScales.svelte';
import { ScaleRegistry } from './ScaleRegistry.svelte';
import { SCALE_PRIORITIES, resolveScaleConfiguration } from './ScalePriorities';

const registry = new ScaleRegistry();
let charts = 0;

function chart(
	options: { xLabel?: string; xScale?: string | false; useXSelection?: boolean } = {}
) {
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

describe('named groups', () => {
	it('do not capture a chart whose column or label has the same text', () => {
		const named = onX(chart({ xScale: 'capture' }), 'dep_delay');
		expect(named).not.toBe(onX(chart(), 'capture'));
		expect(named).not.toBe(onX(chart({ xLabel: 'capture' }), 'arr_delay'));
	});

	it.each(['band', 'point', 'time'])('are ignored with one warning on a %s axis', (type) => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const on = (column: string, xScale?: string) => {
			const scales = chart({ xScale });
			scales.registerScaleType('x', type, SCALE_PRIORITIES.MANDATE, 'm', {}, column);
			return scales.xScaleState;
		};
		const departure = on(`dep_${type}`, 'schedule');
		expect(warn.mock.calls.filter(([m]) => String(m).includes('is ignored'))).toHaveLength(1);
		// Never one scale for two columns; the same column shares as it does unnamed.
		expect(on(`arr_${type}`, 'schedule')).not.toBe(departure);
		expect(on(`dep_${type}`)).toBe(departure);
		warn.mockRestore();
	});
});

describe('an aggregate among several marks', () => {
	it.each([
		['first', [count(), 'target']],
		['last', ['target', count()]]
	] as const)('registered %s: the axis counts as an aggregate’s', (_order, columns) => {
		const mixed = chart();
		columns.forEach((column, i) => onX(mixed, column, `mark-${i}`));
		// Resolved directly: Vitest compiles runes for the server, where
		// scaleConfigurations keeps what it computed after the first registration.
		const resolved = resolveScaleConfiguration(mixed.scaleRequirements.x as never);
		expect(resolved?.aggregate).toBe(true);
	});
});

describe('the scale a following chart takes its domain from', () => {
	function link(
		overview: Parameters<typeof chart>[0],
		detail: Parameters<typeof chart>[0],
		column: () => unknown
	) {
		const source = chart(overview);
		const written = onX(source, column());
		const release = source.registerBrushTarget('x');
		const follower = chart({ ...detail, useXSelection: true });
		const own = onX(follower, column());
		return { written, release, follower, own };
	}

	it.each([
		['both default', {}, {}, () => 'link_a'],
		['detail xScale={false}', {}, { xScale: false }, () => 'link_b'],
		['overview xScale={false}', { xScale: false }, {}, () => 'link_c'],
		['different group names', { xScale: 'over' }, { xScale: 'detail' }, () => 'link_d'],
		['an unlabelled aggregate', {}, {}, () => count()]
	] as const)('%s: the scale the brush writes', (_name, overview, detail, column) => {
		const { written, release, follower, own } = link(overview, detail, column);
		expect(follower.selectionSourceScale('x')).toBe(written);
		expect(own).not.toBe(written);
		release?.();
	});

	it('prefers the brushed overview to an unbrushed chart sharing the column', () => {
		onX(chart(), 'link_e');
		const { written, follower, release } = link({ xScale: false }, {}, () => 'link_e');
		expect(follower.selectionSourceScale('x')).toBe(written);
		release?.();
	});

	it('stops following a chart-local overview once its brush is gone', () => {
		const { follower, release } = link({ xScale: false }, {}, () => 'link_f');
		release?.();
		expect(follower.selectionSourceScale('x')).toBeNull();
	});

	it('a following chart’s own brush is no source', () => {
		const follower = chart({ useXSelection: true });
		onX(follower, 'link_g');
		expect(follower.registerBrushTarget('x')).toBeUndefined();
	});
});

describe('the title of an axis without a label', () => {
	const titleOf = (value: unknown, xLabel?: string) => {
		const scales = chart({ xLabel });
		onX(scales, value);
		return scales.xTitle;
	};

	it.each([
		['a column', () => 'temp_max', 'temp_max'],
		['column(), unquoted', () => column('economy (mpg)'), 'economy (mpg)'],
		['a bin of a column', () => bin('distance'), 'distance'],
		['a bin of column()', () => bin(column('flipper_length')), 'flipper_length']
	] as const)('%s: its name', (_name, value, title) => {
		expect(titleOf(value())).toBe(title);
	});

	it.each([
		['a date function (/mosaic/weather)', () => dateMonthDay('date')],
		['count()', () => count()],
		['sum()', () => sum('fare')],
		['a sql fragment', () => sql`100.0 / ${column('economy (mpg)')}`],
		['a bin of an expression', () => bin(dateMonthDay('date'))],
		['a constant', () => 10]
	] as const)('%s: none, never SQL', (_name, value) => {
		expect(titleOf(value())).toBeNull();
	});

	it('a label always wins, and an empty one hides the title', () => {
		expect(titleOf(dateMonthDay('date'), 'Day of year')).toBe('Day of year');
		expect(titleOf('temp_max', '')).toBe('');
	});

	it.each([
		['one column twice', () => ['temp', 'temp'], 'temp'],
		['a column and a constant rule', () => [10, 'temp'], 'temp'],
		['two columns', () => ['Open', 'Close'], null],
		['a column, then an expression', () => ['target', count()], null],
		['an expression, then a column', () => [count(), 'target'], null]
	] as const)('several marks, %s', (_name, values, title) => {
		const scales = chart();
		values().forEach((value, i) => onX(scales, value, `title-${i}`));
		const resolved = resolveScaleConfiguration(scales.scaleRequirements.x as never);
		expect(resolved?.title).toBe(title);
	});
});
