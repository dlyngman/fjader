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

	it('loads every table when their bytes are views into one shared buffer', async () => {
		// Like DuckDB-WASM, the insert transfers (detaches) the buffer it is given.
		const received = new Map<string, number[]>();
		const engine = {
			exec: async () => {},
			insertArrowFromIPCStream: async (data: Uint8Array, opts: { name: string }) => {
				received.set(opts.name, Array.from(data));
				structuredClone(data.buffer, { transfer: [data.buffer] });
			},
			clearQueryCache: async () => {}
		} as unknown as QueryEngine;
		const blob = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
		await Promise.all([
			loadArrowIPCTable(engine, 'shared_a', new Uint8Array(blob.buffer, 0, 3), 'h1'),
			loadArrowIPCTable(engine, 'shared_b', new Uint8Array(blob.buffer, 3, 4), 'h1')
		]);
		expect(received.get('shared_a')).toEqual([1, 2, 3]);
		expect(received.get('shared_b')).toEqual([4, 5, 6, 7]);
		expect(blob.byteLength).toBe(7);
	});

	it('refuses empty bytes and does not record the table as loaded', async () => {
		const { engine, calls } = fakeEngine();
		await expect(loadArrowIPCTable(engine, 'empty', new Uint8Array(0), 'h1')).rejects.toThrow(
			/empty/
		);
		await loadArrowIPCTable(engine, 'empty', bytes, 'h1');
		expect(calls).toEqual(['DROP TABLE IF EXISTS "empty"', 'insert empty']);
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
