import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilterGroup } from '$lib/query-engine/FilterGroup.svelte';
import type { QueryEngine } from '$lib/query-engine/QueryEngine';
import { ClauseRelay } from './relay-clauses';

function mockEngine() {
	return {
		activate: vi.fn(() => Promise.resolve()),
		onFilterChange: vi.fn(),
		onClauseChange: vi.fn(),
		forgetSource: vi.fn(),
		identitySqlFor: () => null
	};
}

const range = (column: string) => (value: unknown) => ({
	kind: 'range',
	column,
	values: value as number[]
});

const SOURCE_CHART = { name: 'source chart' };

let source: FilterGroup;
let target: FilterGroup;
let targetEngine: ReturnType<typeof mockEngine>;
let relay: ClauseRelay;

beforeEach(() => {
	source = new FilterGroup();
	source.setEngine(mockEngine() as unknown as QueryEngine);
	target = new FilterGroup();
	targetEngine = mockEngine();
	target.setEngine(targetEngine as unknown as QueryEngine);
	relay = new ClauseRelay(source, target);
});

describe('ClauseRelay', () => {
	it('relays a toggle once, however often the axis brush moves', () => {
		const brush = source.register('brush-ts', { chart: SOURCE_CHART, augment: range('ts') });
		const toggle = source.registerToggle('dow');
		toggle.set([['Mon']]);
		relay.sync(true, 'ts');
		expect(targetEngine.onClauseChange).toHaveBeenCalledTimes(1);

		for (let i = 0; i < 20; i++) {
			brush.update(`ts > ${i}`, [i, i + 1]);
			relay.sync(true, 'ts');
		}
		// The axis brush is never relayed, and the unchanged toggle is not re-sent.
		expect(targetEngine.onClauseChange).toHaveBeenCalledTimes(1);
		expect(target.items.map((item) => item.sourceId)).toEqual(['manual:relay:toggle-dow']);
	});

	it('re-sends a clause when it changes, and removes it when it goes', () => {
		const toggle = source.registerToggle('dow');
		toggle.set([['Mon']]);
		relay.sync(true, 'ts');
		toggle.set([['Tue']]);
		relay.sync(true, 'ts');
		expect(targetEngine.onClauseChange).toHaveBeenCalledTimes(2);
		expect(target.items[0].value).toEqual([['Tue']]);

		toggle.clear();
		relay.sync(true, 'ts');
		expect(target.items).toHaveLength(0);
	});

	it('relays the source’s own clause object, without its chart skip', () => {
		source
			.register('brush-delay', { chart: SOURCE_CHART, augment: range('delay') })
			.update('delay > 5', [5, 10]);
		relay.sync(true, 'ts');

		const relayed = target.selection.get('manual:relay:brush-delay')!;
		expect(relayed).toBe(source.selection.get('brush-delay'));
		expect(relayed.schema).toEqual({ kind: 'range', column: 'delay', values: [5, 10] });
		// The skip belongs to the source group's registration: in the target, a
		// mark in the source chart is filtered.
		expect(target.selection.predicate({ reads: [], chart: SOURCE_CHART })).toEqual(['delay > 5']);
	});

	it('relays a categorical toggle so it dims, not filters, the target marks reading its field', () => {
		source.registerToggle('carrier').set([['UA']]);
		relay.sync(true, 'ts');
		expect(target.selection.predicate({ reads: ['carrier'], chart: null })).toEqual([]);
		expect(target.activity('carrier').opacityOfValue(target.index, 'DL')).toBeLessThan(1);
	});

	it('with relaying off, or on clear, removes what it relayed', () => {
		source.registerToggle('dow').set([['Mon']]);
		relay.sync(true, 'ts');
		relay.sync(false, 'ts');
		expect(target.items).toHaveLength(0);

		relay.sync(true, 'ts');
		relay.clear();
		expect(target.items).toHaveLength(0);
	});
});
