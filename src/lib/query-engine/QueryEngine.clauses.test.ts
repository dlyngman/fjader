/**
 * Which marks a clause change re-queries: only those the old or the new
 * clause filters. A mark neither filters keeps the same SQL, and querying it
 * anyway assembled that SQL on every brush frame to find the cached result.
 * Whether a clause filters a mark is the mark's route: a categorical clause on
 * a field it reads dims it, and a source with a registration in its chart
 * skips it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { column, count } from '@uwdata/mosaic-sql';
import { QueryEngine, type DuckDBConnection } from './QueryEngine';
import { FilterGroup } from './FilterGroup.svelte';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { buildQueryParts } from '$lib/components/marks/lifecycle/query-builder';

const CHART_A = { name: 'A' };
const CHART_B = { name: 'B' };

function connection(): DuckDBConnection {
	return {
		async query() {
			return [] as never;
		},
		async close() {}
	};
}

let engine: QueryEngine;
let group: FilterGroup;
let queried: string[];

/** Register a mark counting by `field`, so every mark has its own SQL. */
function mark(
	markId: string,
	field: string,
	chart: object,
	reads: string[] = [],
	into: FilterGroup = group
): void {
	engine.registerMark(
		markId,
		{
			table: 't',
			baseTable: 't',
			parts: buildQueryParts({ x: column(field), n: count() }, null, false),
			schema: new Map(),
			transformCompiler: new TransformCompiler([]),
			route: { reads, chart }
		},
		into
	);
}

beforeEach(() => {
	engine = new QueryEngine(connection());
	group = new FilterGroup();
	group.setEngine(engine);
	mark('a1', 'cat', CHART_A, ['cat']);
	mark('a2', 'q', CHART_A);
	mark('b1', 'r', CHART_B);
	queried = [];
	vi.spyOn(engine, 'query').mockImplementation((_sql, opts) => {
		queried.push(opts!.callerId!);
		return Promise.resolve([] as never);
	});
});

/** The marks queried by an action, in order. */
function queriedBy(action: () => void): string[] {
	queried.length = 0;
	action();
	return [...queried].sort();
}

describe('a clause change', () => {
	it('re-queries only the marks a brush filters, on every frame', () => {
		const brush = group.register('brush', { chart: CHART_A });
		expect(queriedBy(() => brush.update('x > 1', [1]))).toEqual(['b1']);
		expect(queriedBy(() => brush.update('x > 2', [2]))).toEqual(['b1']);
		expect(queriedBy(() => brush.clear())).toEqual(['b1']);
	});

	it('does not re-query a mark that reads the selected field: it dims', () => {
		const legend = group.registerToggle('cat');
		expect(queriedBy(() => legend.set([['u']]))).toEqual(['a2', 'b1']);
	});

	it('skips a chart holding any registration of the source, whichever writes', () => {
		const toggle = group.registerToggle('cat', { chart: CHART_A });
		const legend = group.registerToggle('cat');
		// Chart A keeps its data for the legend's write too: that was the bug.
		expect(queriedBy(() => legend.set([['v']]))).toEqual(['b1']);
		expect(queriedBy(() => toggle.set([['u']]))).toEqual(['b1']);
	});

	it('re-queries the marks the removed clause filtered', () => {
		const brush = group.register('brush', { chart: CHART_A });
		brush.update('x > 1', [1]);
		expect(queriedBy(() => group.clearSource('brush'))).toEqual(['b1']);
		expect(queriedBy(() => group.clearSource('brush'))).toEqual([]);
	});

	it('routes a source’s last destroy by its registrations, still in place', () => {
		const brush = group.register('brush', { chart: CHART_A });
		brush.update('x > 1', [1]);
		expect(queriedBy(() => brush.destroy())).toEqual(['b1']);
	});

	it('re-queries nothing for a manual clause that was never there', () => {
		expect(queriedBy(() => group.removeManual('k'))).toEqual([]);
		expect(queriedBy(() => group.upsertManual('k', 'x > 1', 1))).toEqual(['a1', 'a2', 'b1']);
		expect(queriedBy(() => group.removeManual('k'))).toEqual(['a1', 'a2', 'b1']);
	});

	it('leaves marks in other groups alone', () => {
		const other = new FilterGroup();
		other.setEngine(engine);
		mark('c1', 's', CHART_B, [], other);
		const brush = group.register('brush', {});
		expect(queriedBy(() => brush.update('x > 1', [1]))).toEqual(['a1', 'a2', 'b1']);
	});

	it('clearAll re-queries the whole group', () => {
		group.register('brush', { chart: CHART_A }).update('x > 1', [1]);
		expect(queriedBy(() => group.clearAll())).toEqual(['a1', 'a2', 'b1']);
	});
});

describe('a registration that skips a chart', () => {
	it('mounting under an active selection re-queries that chart’s marks', () => {
		group.registerToggle('cat').set([['u']]);
		expect(queriedBy(() => group.registerToggle('cat', { chart: CHART_A }))).toEqual(['a1', 'a2']);
	});

	it('mounting with nothing selected re-queries nothing', () => {
		expect(queriedBy(() => group.registerToggle('cat', { chart: CHART_A }))).toEqual([]);
	});

	it('unmounting while another keeps the clause re-queries that chart; the chart filters again', () => {
		const legend = group.registerToggle('cat');
		const toggle = group.registerToggle('cat', { chart: CHART_A });
		legend.set([['u']]);
		expect(queriedBy(() => toggle.destroy())).toEqual(['a1', 'a2']);
		expect(group.selection.predicate({ reads: [], chart: CHART_A })).toHaveLength(1);
	});

	it('one of two Toggles in a chart unmounting leaves the chart skipping', () => {
		const first = group.registerToggle('cat', { chart: CHART_A });
		group.registerToggle('cat', { chart: CHART_A });
		first.set([['u']]);
		first.destroy();
		expect(group.selection.predicate({ reads: [], chart: CHART_A })).toEqual([]);
	});
});
