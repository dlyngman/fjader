import { describe, it, expect } from 'vitest';
import { loadArrowIPCTable } from './loadArrowIPC';
import type { QueryEngine } from '$lib/query-engine/QueryEngine';

/**
 * A notebook cell re-run with changed data replaces the table's rows under the
 * same name; results cached from the old rows must not survive it.
 */
function fakeEngine() {
	const calls: string[] = [];
	const engine = {
		exec: async (sql: string) => {
			calls.push(sql);
		},
		insertArrowFromIPCStream: async (_: Uint8Array, opts: { name: string }) => {
			calls.push(`insert ${opts.name}`);
		},
		clearQueryCache: async () => {
			calls.push('clearQueryCache');
		}
	} as unknown as QueryEngine;
	return { engine, calls };
}

const bytes = new Uint8Array(4);

describe('loadArrowIPCTable', () => {
	it('does not clear caches on a first load', async () => {
		const { engine, calls } = fakeEngine();
		await loadArrowIPCTable(engine, 'first_load', bytes, 'h1');
		expect(calls).toEqual(['DROP TABLE IF EXISTS "first_load"', 'insert first_load']);
	});

	it('skips a load with an unchanged hash', async () => {
		const { engine, calls } = fakeEngine();
		await loadArrowIPCTable(engine, 'same_hash', bytes, 'h1');
		calls.length = 0;
		await loadArrowIPCTable(engine, 'same_hash', bytes, 'h1');
		expect(calls).toEqual([]);
	});

	it('clears caches after replacing a table under the same name', async () => {
		const { engine, calls } = fakeEngine();
		await loadArrowIPCTable(engine, 'replaced', bytes, 'h1');
		calls.length = 0;
		await loadArrowIPCTable(engine, 'replaced', bytes, 'h2');
		expect(calls).toEqual([
			'DROP TABLE IF EXISTS "replaced"',
			'insert replaced',
			'clearQueryCache'
		]);
	});
});
