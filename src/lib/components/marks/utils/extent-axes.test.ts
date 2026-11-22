import { describe, it, expect } from 'vitest';
import { bin, isBinExpression } from '$lib/sql/bin';
import { barValueAxis, rectExtent } from './extent-axes';

describe('barValueAxis', () => {
	const ends = { lo: 'started', hi: 'ended' };

	it('both ends as date columns: a time axis (a timeline)', () => {
		expect(barValueAxis('BarMarkX', 'x', ends, true, 'time')).toEqual({
			type: 'time',
			error: null
		});
	});

	it('both ends as numeric columns: linear', () => {
		expect(barValueAxis('BarMarkX', 'x', ends, true, 'linear')).toEqual({
			type: 'linear',
			error: null
		});
	});

	it('both ends as columns, schema not loaded yet: waits', () => {
		expect(barValueAxis('BarMarkX', 'x', ends, true, null)).toEqual({ type: null, error: null });
	});

	it('a length from zero is linear at once, without waiting for the schema', () => {
		expect(barValueAxis('BarMarkX', 'x', { lo: undefined, hi: 'n' }, false, null)).toEqual({
			type: 'linear',
			error: null
		});
	});

	it('a date length is refused, naming both ends', () => {
		const { type, error } = barValueAxis(
			'BarMarkY',
			'y',
			{ lo: undefined, hi: 'day' },
			false,
			'time'
		);
		expect(type).toBeNull();
		expect(error).toContain('y="day" is a date');
		expect(error).toContain('y1 and y2');
	});

	it('a constant start is a length, as before', () => {
		expect(barValueAxis('BarMarkX', 'x', { lo: 0, hi: 'n' }, true, 'linear')).toEqual({
			type: 'linear',
			error: null
		});
	});
});

describe('rectExtent', () => {
	it('explicit edges pass through', () => {
		expect(rectExtent('RectMark', 'x', null, { lo: 'a', hi: 'b' })).toEqual({
			lo: 'a',
			hi: 'b',
			error: null
		});
	});

	it('bin() spans a bin: its lower edge and the next', () => {
		const b = bin('delay');
		const { lo, hi, error } = rectExtent('RectYMark', 'x', b, { lo: null, hi: null });
		expect(error).toBeNull();
		expect(lo).toBe(b);
		expect(isBinExpression(hi) && hi.options.offset).toBe(1);
	});

	it('a plain channel has no extent, and points a category to the bar mark', () => {
		const y = rectExtent('RectMark', 'y', 'task', { lo: null, hi: null });
		expect(y.lo).toBeNull();
		expect(y.hi).toBeNull();
		expect(y.error).toContain('RectMark: y="task" has no extent');
		expect(y.error).toContain('use BarMarkX');

		expect(rectExtent('RectYMark', 'x', 'task', { lo: null, hi: null }).error).toContain(
			'use BarMarkY'
		);
	});
});
