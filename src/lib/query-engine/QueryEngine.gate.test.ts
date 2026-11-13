import { describe, it, expect, vi, beforeEach } from 'vitest';
import { column, count } from '@uwdata/mosaic-sql';
import { QueryEngine, type DuckDBConnection } from './QueryEngine';
import { FilterGroup } from './FilterGroup.svelte';
import { MarkHandle } from './MarkHandle.svelte';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { buildQueryParts } from '$lib/components/marks/lifecycle/query-builder';

/**
 * The off-screen gate: an inactive mark that already has its first result is
 * not re-queried; it goes stale and queries once when it is active again.
 */
const conn: DuckDBConnection = {
	async query() {
		return [] as never;
	},
	async close() {}
};

let engine: QueryEngine;
let group: FilterGroup;
let queried: string[];

function mark(markId: string, field: string): MarkHandle {
	return engine.registerMark(
		markId,
		{
			table: 't',
			baseTable: 't',
			parts: buildQueryParts({ x: column(field), n: count() }, null, false),
			schema: new Map(),
			transformCompiler: new TransformCompiler([]),
			route: { reads: [], chart: {} }
		},
		group
	);
}

/** Give a handle its first result, as the engine would. */
function landed(handle: MarkHandle): void {
	handle._setResult({ numRows: 0 } as never);
}

beforeEach(() => {
	engine = new QueryEngine(conn);
	group = new FilterGroup();
	group.setEngine(engine);
	queried = [];
	// Mark queries only: registering also sends the preagg size guard, with no caller id.
	vi.spyOn(engine, 'query').mockImplementation((_sql, opts) => {
		if (opts?.callerId) queried.push(opts.callerId);
		return Promise.resolve([] as never);
	});
});

describe('off-screen gate', () => {
	it('does not re-query an inactive mark that has its first result', () => {
		const h = mark('m', 'a');
		landed(h);
		h.setActive(false);
		engine.onFilterChange(group);
		expect(queried).toEqual([]);
	});

	it('queries a stale mark once when it becomes active, however many changes it missed', () => {
		const h = mark('m', 'a');
		landed(h);
		h.setActive(false);
		engine.onFilterChange(group);
		engine.onFilterChange(group);
		h.updateParams({ sort: undefined, limit: 10 });
		expect(queried).toEqual([]);
		h.setActive(true);
		expect(queried).toEqual(['m']);
		h.setActive(false);
		h.setActive(true);
		expect(queried).toEqual(['m']);
	});

	it('still runs an inactive mark first query: it can feed shared domains', () => {
		const h = mark('m', 'a');
		h.setActive(false);
		engine.onFilterChange(group);
		expect(queried).toEqual(['m']);
	});

	it('queries nothing on activation when nothing was missed', () => {
		const h = mark('m', 'a');
		landed(h);
		h.setActive(false);
		h.setActive(true);
		expect(queried).toEqual([]);
	});

	it('leaves active marks alone: only the inactive one is skipped', () => {
		const on = mark('on', 'a');
		const off = mark('off', 'b');
		landed(on);
		landed(off);
		off.setActive(false);
		engine.onFilterChange(group);
		expect(queried).toEqual(['on']);
	});

	it('stops activating a mark once it is destroyed', () => {
		const h = mark('m', 'a');
		landed(h);
		h.setActive(false);
		engine.onFilterChange(group);
		h.destroy();
		h.setActive(true);
		expect(queried).toEqual([]);
	});
});
