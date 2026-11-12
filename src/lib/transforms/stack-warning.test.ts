import { describe, it, expect, vi, afterEach } from 'vitest';
import { Query, column, sum } from '@uwdata/mosaic-sql';
import type { SelectQuery } from '@uwdata/mosaic-sql';
import { stackY, withImplicitStack } from './index';
import type { MarkConfig, SqlTransform } from '$lib/types';

// A bar mark with no fill: one row per band, so a stack is a no-op. Saying so
// helps someone who wrote stackY() and forgot the series; it is noise for the
// stack every such bar mark gets implicitly.

const query = (): SelectQuery =>
	Query.from('t')
		.select({ x: column('a'), y: sum(column('b')) })
		.groupby(column('a')) as SelectQuery;
const config = { markType: 'barY', table: 't', x: 'x', y: 'y' } as MarkConfig;

const noSeriesWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
	warn.mock.calls.filter((args) => String(args[0]).includes('no series column')).length;

let warn: ReturnType<typeof vi.spyOn>;
afterEach(() => warn.mockRestore());

describe('the no-series stack warning', () => {
	it('says nothing for the stack a bar mark adds itself', () => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const [stack] = withImplicitStack([], false, 'y') as SqlTransform[];
		stack.apply(query(), config);
		stack.apply(query(), config);
		expect(noSeriesWarnings(warn)).toBe(0);
	});

	it('warns once for a stack the user wrote, however many queries it builds', () => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const stack = stackY();
		stack.apply(query(), config);
		stack.apply(query(), config);
		expect(noSeriesWarnings(warn)).toBe(1);
	});

	it('says nothing when there is a series', () => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const q = Query.from('t')
			.select({ x: column('a'), fill: column('c'), y: sum(column('b')) })
			.groupby(column('a'), column('c')) as SelectQuery;
		stackY().apply(q, { ...config, fill: 'fill' } as MarkConfig);
		expect(noSeriesWarnings(warn)).toBe(0);
	});
});
