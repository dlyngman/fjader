import { describe, it, expect } from 'vitest';
import { CrossfilterSelection } from './CrossfilterSelection.svelte';
import type { Clause } from './CrossfilterSelection.svelte';

function makeClause(
	predicate: string,
	excludeMarkIds: string[] = [],
	value: unknown = null
): Clause {
	return {
		predicate,
		excludeMarkIds: new Set(excludeMarkIds),
		value
	};
}

describe('CrossfilterSelection', () => {
	describe('predicate()', () => {
		it('returns empty array when no clauses', () => {
			const sel = new CrossfilterSelection();
			expect(sel.predicate('mark-1')).toEqual([]);
		});

		it('returns all predicates when mark is not excluded', () => {
			const sel = new CrossfilterSelection();
			sel.update('brush-x', makeClause('x BETWEEN 10 AND 20', ['mark-a']));
			sel.update('brush-y', makeClause('y > 5', ['mark-b']));

			const result = sel.predicate('mark-c');
			expect(result).toEqual(['x BETWEEN 10 AND 20', 'y > 5']);
		});

		it('excludes clauses where mark is in excludeMarkIds', () => {
			const sel = new CrossfilterSelection();
			sel.update('brush-x', makeClause('x BETWEEN 10 AND 20', ['mark-a', 'mark-b']));
			sel.update('brush-y', makeClause('y > 5', ['mark-c']));

			// mark-a is excluded from brush-x, but not brush-y
			expect(sel.predicate('mark-a')).toEqual(['y > 5']);
			// mark-c is excluded from brush-y, but not brush-x
			expect(sel.predicate('mark-c')).toEqual(['x BETWEEN 10 AND 20']);
			// mark-d is excluded from nothing
			expect(sel.predicate('mark-d')).toEqual(['x BETWEEN 10 AND 20', 'y > 5']);
		});

		it('handles chart-level cross-filtering (all marks in source chart excluded)', () => {
			const sel = new CrossfilterSelection();
			const chartAMarks = ['dots-a1', 'bars-a2', 'line-a3'];

			sel.update('interval-x-chartA', makeClause('x BETWEEN 0 AND 100', chartAMarks));

			// All marks in chart A are excluded
			expect(sel.predicate('dots-a1')).toEqual([]);
			expect(sel.predicate('bars-a2')).toEqual([]);
			expect(sel.predicate('line-a3')).toEqual([]);

			// Marks in chart B receive the filter
			expect(sel.predicate('dots-b1')).toEqual(['x BETWEEN 0 AND 100']);
		});
	});

	describe('update()', () => {
		it('adds a clause', () => {
			const sel = new CrossfilterSelection();
			sel.update('src-1', makeClause('x > 0'));
			expect(sel.activeCount).toBe(1);
			expect(sel.isActive('src-1')).toBe(true);
		});

		it('removes a clause when passed null', () => {
			const sel = new CrossfilterSelection();
			sel.update('src-1', makeClause('x > 0'));
			sel.update('src-1', null);
			expect(sel.activeCount).toBe(0);
			expect(sel.isActive('src-1')).toBe(false);
		});

		it('replaces a clause for the same source', () => {
			const sel = new CrossfilterSelection();
			sel.update('src-1', makeClause('x > 0'));
			sel.update('src-1', makeClause('x > 10'));
			expect(sel.activeCount).toBe(1);
			expect(sel.predicate('other')).toEqual(['x > 10']);
		});
	});

	describe('get()', () => {
		it('returns clause by sourceId', () => {
			const sel = new CrossfilterSelection();
			const clause = makeClause('x > 0', ['m1'], 42);
			sel.update('src-1', clause);

			expect(sel.get('src-1')).toEqual(clause);
		});

		it('returns undefined for unknown sourceId', () => {
			const sel = new CrossfilterSelection();
			expect(sel.get('nonexistent')).toBeUndefined();
		});
	});

	describe('items', () => {
		it('returns all active clauses with sourceId', () => {
			const sel = new CrossfilterSelection();
			sel.update('src-1', makeClause('x > 0', ['m1'], [0, 100]));
			sel.update('src-2', makeClause('y < 50', ['m2'], [0, 50]));

			const items = sel.items;
			expect(items).toHaveLength(2);
			expect(items[0].sourceId).toBe('src-1');
			expect(items[0].predicate).toBe('x > 0');
			expect(items[1].sourceId).toBe('src-2');
		});

		it('reflects removals', () => {
			const sel = new CrossfilterSelection();
			sel.update('src-1', makeClause('x > 0'));
			sel.update('src-2', makeClause('y > 0'));
			sel.update('src-1', null);

			expect(sel.items).toHaveLength(1);
			expect(sel.items[0].sourceId).toBe('src-2');
		});
	});

	describe('clear()', () => {
		it('removes all clauses', () => {
			const sel = new CrossfilterSelection();
			sel.update('src-1', makeClause('x > 0'));
			sel.update('src-2', makeClause('y > 0'));
			sel.clear();

			expect(sel.activeCount).toBe(0);
			expect(sel.items).toHaveLength(0);
			expect(sel.predicate('any')).toEqual([]);
		});
	});

	describe('multi-chart crossfilter scenario', () => {
		it('handles overlapping brushes from different charts', () => {
			const sel = new CrossfilterSelection();
			const chartAMarks = ['dots-a', 'bars-a'];
			const chartBMarks = ['dots-b'];

			// Brush on chart A's x-axis
			sel.update('brush-x-A', makeClause('x BETWEEN 10 AND 20', chartAMarks));
			// Brush on chart B's y-axis
			sel.update('brush-y-B', makeClause('y BETWEEN 0 AND 50', chartBMarks));

			// Chart A marks: get chart B's brush, not their own
			expect(sel.predicate('dots-a')).toEqual(['y BETWEEN 0 AND 50']);
			expect(sel.predicate('bars-a')).toEqual(['y BETWEEN 0 AND 50']);

			// Chart B marks: get chart A's brush, not their own
			expect(sel.predicate('dots-b')).toEqual(['x BETWEEN 10 AND 20']);

			// Chart C marks: get both brushes
			expect(sel.predicate('dots-c')).toEqual([
				'x BETWEEN 10 AND 20',
				'y BETWEEN 0 AND 50'
			]);
		});

		it('handles brush clear from one chart', () => {
			const sel = new CrossfilterSelection();
			sel.update('brush-x-A', makeClause('x BETWEEN 10 AND 20', ['dots-a']));
			sel.update('brush-y-B', makeClause('y BETWEEN 0 AND 50', ['dots-b']));

			// Clear chart A's brush
			sel.update('brush-x-A', null);

			// Only chart B's brush remains
			expect(sel.predicate('dots-a')).toEqual(['y BETWEEN 0 AND 50']);
			expect(sel.predicate('dots-b')).toEqual([]);
			expect(sel.predicate('dots-c')).toEqual(['y BETWEEN 0 AND 50']);
		});
	});
});
