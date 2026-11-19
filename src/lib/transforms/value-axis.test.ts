import { describe, expect, it } from 'vitest';
import { markValueAxis, valueAxisOf } from './value-axis';

describe('markValueAxis', () => {
	it('takes bars at their type', () => {
		expect(markValueAxis('barx', 'band', 'band')).toBe('x');
		expect(markValueAxis('bary', 'linear', 'band')).toBe('y');
	});

	it('puts the value on x for another mark over a categorical y', () => {
		expect(markValueAxis('text', 'linear', 'band')).toBe('x');
		expect(markValueAxis('dot', 'linear', 'point')).toBe('x');
		expect(markValueAxis('text', undefined, 'band')).toBe('x');
	});

	it('keeps y otherwise', () => {
		expect(markValueAxis('text', 'band', 'linear')).toBe('y');
		expect(markValueAxis('dot', 'linear', 'linear')).toBe('y');
		expect(markValueAxis('text', 'band', 'band')).toBe('y');
		expect(markValueAxis('text', null, null)).toBe('y');
	});
});

describe('valueAxisOf', () => {
	it('reads the resolved axis, else decides by mark type', () => {
		expect(valueAxisOf({ markType: 'text', valueAxis: 'x' })).toBe('x');
		expect(valueAxisOf({ markType: 'barx' })).toBe('x');
		expect(valueAxisOf({ markType: 'text' })).toBe('y');
		expect(valueAxisOf(undefined)).toBe('y');
	});
});
