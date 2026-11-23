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
import { TimeScaleState, originShift } from './TimeScaleState.svelte';
import type { LinearScaleState } from './LinearScaleState.svelte';
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

	it.each(['band', 'point'])('are ignored with one warning on a %s axis', (type) => {
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

describe('time axes share as numeric ones do', () => {
	// Each mark draws its own date column from the shared origin, so two date
	// columns can be one axis: a timeline's start and end, or order and ship dates.
	function onTime(scales: ChartScales, column: string) {
		scales.registerScaleType('x', 'time', SCALE_PRIORITIES.MANDATE, `t${charts}`, {}, column);
		return scales.xScaleState;
	}

	it('a named group shares two date columns, without a warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const a = onTime(chart({ xScale: 'schedule' }), 'started');
		const b = onTime(chart({ xScale: 'schedule' }), 'ended');
		expect(a).toBe(b);
		expect(warn.mock.calls.filter(([m]) => String(m).includes('is ignored'))).toEqual([]);
		warn.mockRestore();
	});

	it('the same label shares two date columns', () => {
		const a = onTime(chart({ xLabel: 'when' }), 'ordered');
		const b = onTime(chart({ xLabel: 'when' }), 'shipped');
		expect(a).toBe(b);
	});

	it('without a label, only the same column shares', () => {
		const a = onTime(chart(), 'opened');
		expect(onTime(chart(), 'closed')).not.toBe(a);
		expect(onTime(chart(), 'opened')).toBe(a);
	});

	it('a following chart takes the brushed overview on another date column', () => {
		const overview = chart({ xLabel: 'period' });
		const written = onTime(overview, 'from_date');
		const release = overview.registerBrushTarget('x');
		const follower = chart({ xLabel: 'period', xScale: false, useXSelection: true });
		onTime(follower, 'to_date');
		expect(follower.selectionSourceScale('x')).toBe(written);
		release?.();
	});

	it('of several brushed overviews, a follower takes the one on its own column', () => {
		const from = chart({ xLabel: 'span', xScale: false });
		onTime(from, 'from_date');
		const releaseFrom = from.registerBrushTarget('x');
		const to = chart({ xLabel: 'span', xScale: false });
		const own = onTime(to, 'to_date');
		const releaseTo = to.registerBrushTarget('x');

		const follower = chart({ xLabel: 'span', xScale: false, useXSelection: true });
		onTime(follower, 'to_date');
		// from_date's brush registered first; the follower's own column wins.
		expect(follower.selectionSourceScale('x')).toBe(own);
		releaseFrom?.();
		releaseTo?.();
	});
});

describe('a window copied between two time scales', () => {
	// What the link effects do with it (they are $effects, which do not run in
	// this server-side test environment): each time scale counts its offsets
	// from its own origin, so a window is shifted by the gap between them.
	const day = (d: string) => new Date(`${d}T00:00:00Z`);
	function timeScale(earliest: string, latest: string) {
		const scale = new TimeScaleState('t', [0, 1], 'time', [1e-6, 1e6], {}, null);
		scale.addDatetimeExtent([day(earliest), day(latest)], 'm', { instant: true });
		return scale;
	}

	it('lands on the same dates, not shifted by the gap between origins', () => {
		const overview = timeScale('2024-01-01', '2024-06-01'); // on from_date
		const follower = timeScale('2024-02-01', '2024-07-01'); // on to_date
		const brush = [
			overview.dateToOffset(day('2024-03-01'))!,
			overview.dateToOffset(day('2024-03-10'))!
		];

		const shift = originShift(overview, follower)!;
		const window = brush.map((offset) => follower.offsetToDate(offset + shift)?.toISOString());
		expect(window).toEqual(['2024-03-01T00:00:00.000Z', '2024-03-10T00:00:00.000Z']);
		// And back: the follower's zoom moves the brush to the same dates.
		const back = originShift(follower, overview)!;
		expect(overview.offsetToDate(follower.dateToOffset(day('2024-03-10'))! + back)).toEqual(
			day('2024-03-10')
		);
	});

	it('no shift between numeric scales, and none known before an origin', () => {
		const empty = new TimeScaleState('t', [0, 1], 'time', [1e-6, 1e6], {}, null);
		expect(originShift(timeScale('2024-01-01', '2024-02-01'), empty)).toBeNull();
		const linear = onX(chart(), 'shift_linear') as LinearScaleState;
		expect(originShift(linear, linear)).toBe(0);
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
