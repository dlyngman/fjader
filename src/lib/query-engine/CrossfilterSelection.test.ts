import { describe, it, expect } from 'vitest';
import { CrossfilterSelection, NO_ROUTE } from './CrossfilterSelection.svelte';
import type { Clause, MarkRoute } from './CrossfilterSelection.svelte';

function makeClause(predicate: string, value: unknown = null, key: string | null = null): Clause {
	return {
		predicate,
		value,
		categorical: key ? { key, values: new Set(value as unknown[]) } : null
	};
}

/** Charts are compared by reference, as ChartConfig objects are. */
const CHART_A = { name: 'A' };
const CHART_B = { name: 'B' };
const CHART_C = { name: 'C' };

const inChart = (chart: object | null, reads: string[] = []): MarkRoute => ({ reads, chart });

/** A selectionResponse 'filter' mark: it reads nothing, as its lifecycle builds it. */
const filterIn = (chart: object | null): MarkRoute => ({ reads: [], chart, response: 'filter' });

/** A selection whose sources skip the given charts. */
function selection(sources: Record<string, object | null> = {}): CrossfilterSelection {
	const sel = new CrossfilterSelection();
	for (const [sourceId, chart] of Object.entries(sources)) sel.addRegistration(sourceId, { chart });
	return sel;
}

/** A selection whose click sources (Toggles, legends) skip the given charts. */
function clicks(sources: Record<string, object | null>): CrossfilterSelection {
	const sel = new CrossfilterSelection();
	for (const [sourceId, chart] of Object.entries(sources)) {
		sel.addRegistration(sourceId, { chart, discrete: true });
	}
	return sel;
}

describe('CrossfilterSelection', () => {
	describe('predicate()', () => {
		it('returns empty array when no clauses', () => {
			expect(selection().predicate(NO_ROUTE)).toEqual([]);
		});

		it('gives a mark every clause whose source does not skip its chart', () => {
			const sel = selection({ 'brush-x': CHART_A, 'brush-y': CHART_B });
			sel.update('brush-x', makeClause('x BETWEEN 10 AND 20'));
			sel.update('brush-y', makeClause('y > 5'));

			expect(sel.predicate(inChart(CHART_C))).toEqual(['x BETWEEN 10 AND 20', 'y > 5']);
			expect(sel.predicate(inChart(CHART_A))).toEqual(['y > 5']);
			expect(sel.predicate(inChart(CHART_B))).toEqual(['x BETWEEN 10 AND 20']);
			expect(sel.predicate(NO_ROUTE)).toEqual(['x BETWEEN 10 AND 20', 'y > 5']);
		});

		it('skips a chart while any registration of the source skips it', () => {
			const sel = selection({ toggle: CHART_A });
			const legend = { chart: null };
			sel.addRegistration('toggle', legend);
			sel.update('toggle', makeClause("cat IN ('a')"));
			expect(sel.predicate(inChart(CHART_A))).toEqual([]);

			// The legend leaving changes nothing; the Toggle leaving does.
			sel.removeRegistration('toggle', legend);
			expect(sel.predicate(inChart(CHART_A))).toEqual([]);
			const [toggle] = sel.registrationsOf('toggle')!;
			sel.removeRegistration('toggle', toggle);
			expect(sel.predicate(inChart(CHART_A))).toEqual(["cat IN ('a')"]);
		});

		it('leaves out a categorical clause on a field the mark reads: it dims instead', () => {
			const sel = selection({ legend: null });
			sel.update('legend', makeClause("carrier IN ('UA')", ['UA'], 'carrier'));
			expect(sel.predicate(inChart(CHART_A, ['carrier']))).toEqual([]);
			expect(sel.predicate(inChart(CHART_A, ['origin']))).toEqual(["carrier IN ('UA')"]);
		});

		it('filters a mark by a brush even on a field it reads: an interval cannot dim', () => {
			const sel = selection({ brush: null });
			sel.update('brush', makeClause('hour BETWEEN 3 AND 9'));
			expect(sel.predicate(inChart(CHART_A, ['hour']))).toEqual(['hour BETWEEN 3 AND 9']);
		});
	});

	describe('filters()', () => {
		it('answers before any clause exists, from the source key and registrations', () => {
			const sel = selection({ legend: CHART_A });
			expect(sel.filters(inChart(CHART_B), 'legend', 'carrier')).toBe(true);
			expect(sel.filters(inChart(CHART_B, ['carrier']), 'legend', 'carrier')).toBe(false);
			expect(sel.filters(inChart(CHART_A), 'legend', 'carrier')).toBe(false);
		});

		it("filters a 'filter' mark by a categorical source registered in its own chart", () => {
			const sel = clicks({ 'toggle-region': CHART_A });
			sel.addRegistration('toggle-region', { chart: CHART_B, discrete: true });
			expect(sel.filters(filterIn(CHART_A), 'toggle-region', 'region')).toBe(true);
			expect(sel.filters(filterIn(CHART_B), 'toggle-region', 'region')).toBe(true);
			// An 'auto' mark in that chart still skips it.
			expect(sel.filters(inChart(CHART_A), 'toggle-region', 'region')).toBe(false);
		});

		it("filters a 'filter' mark by a multi-field Toggle in its own chart: it has no key", () => {
			const sel = clicks({ 'toggle-["region","year"]': CHART_A });
			expect(sel.filters(filterIn(CHART_A), 'toggle-["region","year"]', null)).toBe(true);
			expect(sel.filters(inChart(CHART_A), 'toggle-["region","year"]', null)).toBe(false);
		});

		it("lets a brush skip its own chart for a 'filter' mark too", () => {
			const sel = selection({ brush: CHART_A });
			expect(sel.filters(filterIn(CHART_A), 'brush', null)).toBe(false);
			expect(sel.filters(filterIn(CHART_B), 'brush', null)).toBe(true);
		});
	});

	describe('update()', () => {
		it('adds a clause', () => {
			const sel = selection();
			sel.update('src-1', makeClause('x > 0'));
			expect(sel.activeCount).toBe(1);
			expect(sel.isActive('src-1')).toBe(true);
		});

		it('removes a clause when passed null, and returns it', () => {
			const sel = selection();
			const clause = makeClause('x > 0');
			sel.update('src-1', clause);
			expect(sel.update('src-1', null)).toBe(clause);
			expect(sel.activeCount).toBe(0);
			expect(sel.isActive('src-1')).toBe(false);
		});

		it('replaces a clause for the same source', () => {
			const sel = selection();
			sel.update('src-1', makeClause('x > 0'));
			sel.update('src-1', makeClause('x > 10'));
			expect(sel.activeCount).toBe(1);
			expect(sel.predicate(NO_ROUTE)).toEqual(['x > 10']);
		});
	});

	describe('get()', () => {
		it('returns clause by sourceId', () => {
			const sel = selection();
			const clause = makeClause('x > 0', 42);
			sel.update('src-1', clause);
			expect(sel.get('src-1')).toBe(clause);
		});

		it('returns undefined for unknown sourceId', () => {
			expect(selection().get('nonexistent')).toBeUndefined();
		});
	});

	describe('items', () => {
		it('returns all active clauses with sourceId', () => {
			const sel = selection();
			sel.update('src-1', makeClause('x > 0', [0, 100]));
			sel.update('src-2', makeClause('y < 50', [0, 50]));

			const items = sel.items;
			expect(items).toHaveLength(2);
			expect(items[0].sourceId).toBe('src-1');
			expect(items[0].predicate).toBe('x > 0');
			expect(items[1].sourceId).toBe('src-2');
		});

		it('reflects removals', () => {
			const sel = selection();
			sel.update('src-1', makeClause('x > 0'));
			sel.update('src-2', makeClause('y > 0'));
			sel.update('src-1', null);

			expect(sel.items).toHaveLength(1);
			expect(sel.items[0].sourceId).toBe('src-2');
		});
	});

	describe('clear()', () => {
		it('removes all clauses', () => {
			const sel = selection();
			sel.update('src-1', makeClause('x > 0'));
			sel.update('src-2', makeClause('y > 0'));
			sel.clear();

			expect(sel.activeCount).toBe(0);
			expect(sel.items).toHaveLength(0);
			expect(sel.predicate(NO_ROUTE)).toEqual([]);
		});
	});

	describe('bakedClauses()', () => {
		it('returns the clause objects in insertion order, minus the active brush', () => {
			const sel = selection({ brush: CHART_A });
			const toggle = makeClause("cat IN ('a')");
			const legend = makeClause("kind IN ('x')");
			sel.update('toggle', toggle);
			sel.update('brush', makeClause('x BETWEEN 0 AND 10'));
			sel.update('legend', legend);

			const baked = sel.bakedClauses(inChart(CHART_B), 'brush');
			expect(baked).toHaveLength(2);
			expect(baked[0]).toBe(toggle);
			expect(baked[1]).toBe(legend);
		});

		it('skips clauses that do not filter the mark, and clauses without a predicate', () => {
			const sel = selection({ 'own-toggle': CHART_B });
			sel.update('own-toggle', makeClause("cat IN ('a')"));
			sel.update('empty', makeClause(''));
			sel.update('dimmed', makeClause("kind IN ('x')", ['x'], 'kind'));

			expect(sel.bakedClauses(inChart(CHART_B, ['kind']), 'brush')).toEqual([]);
		});
	});

	describe('bakedPredicates()', () => {
		it('sorts by source ID, whatever the insertion order', () => {
			const sel = selection();
			sel.update('toggle', makeClause("cat IN ('a')"));
			sel.update('legend', makeClause("kind IN ('x')"));
			sel.update('brush', makeClause('x BETWEEN 0 AND 10'));

			expect(sel.bakedPredicates(NO_ROUTE, 'brush')).toEqual(["kind IN ('x')", "cat IN ('a')"]);
		});

		it('gives the same result after a clause is removed and re-added', () => {
			const sel = selection();
			sel.update('legend', makeClause("kind IN ('x')"));
			sel.update('toggle', makeClause("cat IN ('a')"));
			const before = sel.bakedPredicates(NO_ROUTE, 'brush');

			sel.update('legend', null);
			sel.update('legend', makeClause("kind IN ('x')"));

			expect(sel.bakedPredicates(NO_ROUTE, 'brush')).toEqual(before);
		});
	});

	describe('bakedClausesMatch()', () => {
		const route = inChart(CHART_B);

		function setup() {
			const sel = selection({ brush: CHART_A, 'own-toggle': CHART_B });
			sel.update('toggle', makeClause("cat IN ('a')"));
			sel.update('brush', makeClause('x BETWEEN 0 AND 10'));
			return { sel, baked: sel.bakedClauses(route, 'brush') };
		}

		it('matches when nothing changed', () => {
			const { sel, baked } = setup();
			expect(sel.bakedClausesMatch(route, 'brush', baked)).toBe(true);
		});

		it('matches with no clauses at all', () => {
			expect(selection().bakedClausesMatch(route, 'brush', [])).toBe(true);
		});

		it('ignores changes to the active brush', () => {
			const { sel, baked } = setup();
			sel.update('brush', makeClause('x BETWEEN 3 AND 7'));
			expect(sel.bakedClausesMatch(route, 'brush', baked)).toBe(true);
		});

		it('matches when the brush writes its first clause after the build', () => {
			const sel = selection({ brush: CHART_A });
			sel.update('toggle', makeClause("cat IN ('a')"));
			const baked = sel.bakedClauses(route, 'brush');

			sel.update('brush', makeClause('x BETWEEN 0 AND 10'));
			expect(sel.bakedClausesMatch(route, 'brush', baked)).toBe(true);
		});

		it('fails when a baked clause is replaced, even with the same SQL', () => {
			const { sel, baked } = setup();
			sel.update('toggle', makeClause("cat IN ('a')"));
			expect(sel.bakedClausesMatch(route, 'brush', baked)).toBe(false);
		});

		it('fails when a baked clause is removed', () => {
			const { sel, baked } = setup();
			sel.update('toggle', null);
			expect(sel.bakedClausesMatch(route, 'brush', baked)).toBe(false);
		});

		it('fails when a new clause starts filtering the mark', () => {
			const { sel, baked } = setup();
			sel.update('legend', makeClause("kind IN ('x')"));
			expect(sel.bakedClausesMatch(route, 'brush', baked)).toBe(false);
		});

		it('ignores clauses that do not filter the mark', () => {
			const { sel, baked } = setup();
			sel.update('own-toggle', makeClause("cat IN ('b')"));
			expect(sel.bakedClausesMatch(route, 'brush', baked)).toBe(true);
		});
	});

	describe('multi-chart crossfilter scenario', () => {
		it('handles overlapping brushes from different charts', () => {
			const sel = selection({ 'brush-x-A': CHART_A, 'brush-y-B': CHART_B });
			sel.update('brush-x-A', makeClause('x BETWEEN 10 AND 20'));
			sel.update('brush-y-B', makeClause('y BETWEEN 0 AND 50'));

			// Chart A marks: get chart B's brush, not their own
			expect(sel.predicate(inChart(CHART_A))).toEqual(['y BETWEEN 0 AND 50']);
			// Chart B marks: get chart A's brush, not their own
			expect(sel.predicate(inChart(CHART_B))).toEqual(['x BETWEEN 10 AND 20']);
			// Chart C marks: get both brushes
			expect(sel.predicate(inChart(CHART_C))).toEqual([
				'x BETWEEN 10 AND 20',
				'y BETWEEN 0 AND 50'
			]);
		});

		it('handles brush clear from one chart', () => {
			const sel = selection({ 'brush-x-A': CHART_A, 'brush-y-B': CHART_B });
			sel.update('brush-x-A', makeClause('x BETWEEN 10 AND 20'));
			sel.update('brush-y-B', makeClause('y BETWEEN 0 AND 50'));

			sel.update('brush-x-A', null);

			expect(sel.predicate(inChart(CHART_A))).toEqual(['y BETWEEN 0 AND 50']);
			expect(sel.predicate(inChart(CHART_B))).toEqual([]);
			expect(sel.predicate(inChart(CHART_C))).toEqual(['y BETWEEN 0 AND 50']);
		});
	});
});
