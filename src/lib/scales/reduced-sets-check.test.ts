import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDUCED_SETS_QUIET_MS, ReducedSetsCheck } from './reduced-sets-check';

describe('ReducedSetsCheck', () => {
	let warn: ReturnType<typeof vi.fn<(message: string) => void>>;
	let check: ReducedSetsCheck;

	beforeEach(() => {
		vi.useFakeTimers();
		warn = vi.fn<(message: string) => void>();
		check = new ReducedSetsCheck(() => 'route', warn);
	});
	afterEach(() => {
		check.destroy();
		vi.useRealTimers();
	});

	it('is quiet when the marks keep the same categories, in any order', () => {
		check.note('bar', 'ids', [3, 1, 2]);
		check.note('text', 'ids', [2, 3, 1]);
		vi.advanceTimersByTime(REDUCED_SETS_QUIET_MS);
		expect(warn).not.toHaveBeenCalled();
	});

	it('warns once, after the quiet period, when the sets differ', () => {
		check.note('bar', 'ids', [1, 2, 3]);
		check.note('text', 'ids', [1, 2, 9]);
		vi.advanceTimersByTime(REDUCED_SETS_QUIET_MS - 1);
		expect(warn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('"route"');
		expect(warn.mock.calls[0][0]).toContain('bar, text');
		expect(warn.mock.calls[0][0]).toContain('contributeDomain={false}');

		check.note('bar', 'ids', [5]);
		vi.advanceTimersByTime(REDUCED_SETS_QUIET_MS);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('does not warn for a difference the next result settles', () => {
		check.note('bar', 'ids', [1, 2, 3]);
		check.note('text', 'ids', [1, 2, 3]);
		// A filter: the bars re-rank first, the labels land a moment later.
		check.note('bar', 'ids', [4, 5, 6]);
		vi.advanceTimersByTime(200);
		check.note('text', 'ids', [6, 5, 4]);
		vi.advanceTimersByTime(REDUCED_SETS_QUIET_MS);
		expect(warn).not.toHaveBeenCalled();
	});

	it('ignores a mark that left, and a lone mark', () => {
		check.note('bar', 'ids', [1, 2]);
		check.note('text', 'ids', [7, 8]);
		check.remove('text');
		vi.advanceTimersByTime(REDUCED_SETS_QUIET_MS);
		expect(warn).not.toHaveBeenCalled();
	});

	it('does not compare ids with source values', () => {
		check.note('bar', 'ids', [1, 2]);
		check.note('text', 'values', ['a', 'b']);
		vi.advanceTimersByTime(REDUCED_SETS_QUIET_MS);
		expect(warn).not.toHaveBeenCalled();
	});
});
