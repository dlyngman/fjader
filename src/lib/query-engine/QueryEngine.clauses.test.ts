/**
 * Which marks a clause change re-queries: only those the old or the new
 * clause applies to. A mark neither applies to keeps the same SQL, and
 * querying it anyway assembled that SQL on every brush frame to find the
 * cached result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { column, count } from '@uwdata/mosaic-sql';
import { QueryEngine, type DuckDBConnection } from './QueryEngine';
import { FilterGroup } from './FilterGroup.svelte';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { buildQueryParts } from '$lib/components/marks/lifecycle/query-builder';

const CHART_A = new Set(['a1', 'a2']);

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
function mark(markId: string, field: string, into: FilterGroup = group): void {
	engine.registerMark(
		markId,
		{
			table: 't',
			baseTable: 't',
			parts: buildQueryParts({ x: column(field), n: count() }, null, false),
			schema: new Map(),
			transformCompiler: new TransformCompiler([])
		},
		into
	);
}

beforeEach(() => {
	engine = new QueryEngine(connection());
	group = new FilterGroup();
	group.setEngine(engine);
	mark('a1', 'p');
	mark('a2', 'q');
	mark('b1', 'r');
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
	it('re-queries only the marks a brush applies to, on every frame', () => {
		const brush = group.register('brush', { excludeMarkIds: () => CHART_A });
		expect(queriedBy(() => brush.update('x > 1', [1]))).toEqual(['b1']);
		expect(queriedBy(() => brush.update('x > 2', [2]))).toEqual(['b1']);
		expect(queriedBy(() => brush.clear())).toEqual(['b1']);
	});

	it('re-queries the marks of either clause when the writer changes', () => {
		const toggle = group.registerToggle('cat', { excludeMarkIds: () => CHART_A });
		const legend = group.registerToggle('cat', { excludeMarkIds: () => new Set() });

		expect(queriedBy(() => toggle.set([['u']]))).toEqual(['b1']);
		// The legend's clause applies to chart A, which the Toggle's skipped.
		expect(queriedBy(() => legend.set([['v']]))).toEqual(['a1', 'a2', 'b1']);
		// And back: chart A must drop the legend's filter.
		expect(queriedBy(() => toggle.set([['u']]))).toEqual(['a1', 'a2', 'b1']);
	});

	it('re-queries the marks the removed clause applied to', () => {
		const brush = group.register('brush', { excludeMarkIds: () => CHART_A });
		brush.update('x > 1', [1]);
		expect(queriedBy(() => group.clearSource('brush'))).toEqual(['b1']);
		expect(queriedBy(() => group.clearSource('brush'))).toEqual([]);
	});

	it('re-queries nothing for a manual clause that was never there', () => {
		expect(queriedBy(() => group.removeManual('k'))).toEqual([]);
		expect(queriedBy(() => group.upsertManual('k', 'x > 1', 1, new Set(['a1'])))).toEqual([
			'a2',
			'b1'
		]);
		expect(queriedBy(() => group.removeManual('k'))).toEqual(['a2', 'b1']);
	});

	it('leaves marks in other groups alone', () => {
		const other = new FilterGroup();
		other.setEngine(engine);
		mark('c1', 's', other);
		const brush = group.register('brush', { excludeMarkIds: () => new Set() });
		expect(queriedBy(() => brush.update('x > 1', [1]))).toEqual(['a1', 'a2', 'b1']);
	});

	it('clearAll re-queries the whole group', () => {
		group.register('brush', { excludeMarkIds: () => CHART_A }).update('x > 1', [1]);
		expect(queriedBy(() => group.clearAll())).toEqual(['a1', 'a2', 'b1']);
	});
});
