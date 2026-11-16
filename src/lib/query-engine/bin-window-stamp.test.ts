import { describe, it, expect, vi, beforeEach } from 'vitest';
import { column, count } from '@uwdata/mosaic-sql';
import { QueryEngine, type DuckDBConnection } from './QueryEngine';
import { FilterGroup } from './FilterGroup.svelte';
import type { MarkHandle } from './MarkHandle.svelte';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { buildQueryParts } from '$lib/components/marks/lifecycle/query-builder';

/**
 * A result carries the bin window its query was SENT with (`resultWindow`),
 * as it carries its parts: a pan moves the window while a query is in flight,
 * and the old result lands with the old window's rows.
 */
const conn: DuckDBConnection = {
	async query() {
		return [] as never;
	},
	async close() {}
};

let engine: QueryEngine;
let group: FilterGroup;
/** Each mark query in flight: its resolve, in send order. */
let pending: ((table: unknown) => void)[];
let sent: number;

function mark(): MarkHandle {
	return engine.registerMark(
		'm',
		{
			table: 't',
			baseTable: 't',
			parts: buildQueryParts({ x: column('a'), n: count() }, null, false),
			schema: new Map(),
			transformCompiler: new TransformCompiler([]),
			route: { reads: [], chart: {} }
		},
		group
	);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	engine = new QueryEngine(conn);
	group = new FilterGroup();
	group.setEngine(engine);
	pending = [];
	sent = 0;
	vi.spyOn(engine, 'query').mockImplementation((_sql, opts) => {
		if (!opts?.callerId) return Promise.resolve([] as never);
		sent++;
		return new Promise((resolve) => pending.push(resolve as (t: unknown) => void));
	});
});

describe('the bin window stamp', () => {
	it('lands each result with the window it was sent with, not the current one', async () => {
		const h = mark();
		h.setBinWindow([0, 10], true);
		h.setBinWindow([5, 15], true); // a pan, while the first flies
		expect(pending).toHaveLength(2);

		pending[0]({ numRows: 1 });
		await settle();
		expect(h.resultWindow).toEqual([0, 10]);
		pending[1]({ numRows: 2 });
		await settle();
		expect(h.resultWindow).toEqual([5, 15]);
	});

	it('a window set without a re-query goes out with the next query', async () => {
		const h = mark();
		h.setBinWindow([0, 10], false);
		expect(sent).toBe(0);
		h.updateParams({ sort: undefined, limit: undefined });
		expect(sent).toBe(1);
		pending[0]({ numRows: 1 });
		await settle();
		expect(h.resultWindow).toEqual([0, 10]);
	});

	it('the sort and limit push keeps the window', () => {
		const h = mark();
		h.setBinWindow([0, 10], false);
		h.updateParams({ sort: undefined, limit: 5 });
		expect(h.params.binWindow).toEqual([0, 10]);
		expect(h.params.limit).toBe(5);
	});

	it('no window: the result reports the whole extent (null)', async () => {
		const h = mark();
		h.updateParams({ sort: undefined, limit: undefined });
		pending[0]({ numRows: 1 });
		await settle();
		expect(h.resultWindow).toBeNull();
	});
});
