import { describe, it, expect } from 'vitest';
import { parallelAxisColumns } from './ChartScales.svelte';
import { PARALLEL_MAX_AXES } from '$lib/components/rendering/uniform-sizes';

describe('parallelAxisColumns', () => {
	it('is one mark’s columns in its order', () => {
		const byMark = new Map([['m', ['bill_length', 'bill_depth', 'flipper_length']]]);
		expect(parallelAxisColumns(byMark)).toEqual(['bill_length', 'bill_depth', 'flipper_length']);
	});

	it('drops a column the mark no longer has, and puts it back in place', () => {
		const byMark = new Map([['m', ['bill_length', 'flipper_length', 'body_mass']]]);
		expect(parallelAxisColumns(byMark)).toEqual(['bill_length', 'flipper_length', 'body_mass']);
		byMark.set('m', ['bill_length', 'bill_depth', 'flipper_length', 'body_mass']);
		expect(parallelAxisColumns(byMark)).toEqual([
			'bill_length',
			'bill_depth',
			'flipper_length',
			'body_mass'
		]);
	});

	it('is the union over marks, each column once, the first mark’s first', () => {
		const byMark = new Map([
			['a', ['x', 'y']],
			['b', ['y', 'z']]
		]);
		expect(parallelAxisColumns(byMark)).toEqual(['x', 'y', 'z']);
		byMark.delete('a');
		expect(parallelAxisColumns(byMark)).toEqual(['y', 'z']);
	});

	it('holds at most PARALLEL_MAX_AXES, over all marks: the first ones', () => {
		const a = Array.from({ length: 10 }, (_, i) => `a${i}`);
		const b = Array.from({ length: 10 }, (_, i) => `b${i}`);
		const axes = parallelAxisColumns(
			new Map([
				['a', a],
				['b', b]
			])
		);
		expect(axes).toHaveLength(PARALLEL_MAX_AXES);
		expect(axes).toEqual([...a, ...b].slice(0, PARALLEL_MAX_AXES));
	});
});
