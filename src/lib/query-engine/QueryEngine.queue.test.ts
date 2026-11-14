/**
 * The main connection's queue as the engine uses it (MainQueue has the
 * ordering rules): ranks on the records, the cap, and the slot freed before a
 * result decodes.
 */
import { describe, it, expect, vi } from 'vitest';

const events: string[] = [];
vi.mock('@uwdata/flechette', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@uwdata/flechette')>();
	return {
		...actual,
		tableFromIPC: (bytes: Uint8Array, ...rest: unknown[]) => {
			events.push('decode');
			return (actual.tableFromIPC as (...a: unknown[]) => unknown)(bytes, ...rest);
		}
	};
});

import { tableFromArrays, tableToIPC } from '@uwdata/flechette';
import { QueryEngine } from './QueryEngine';
import type { DuckDBConnection, StatementRecord } from './QueryEngine';

const BYTES = tableToIPC(tableFromArrays({ a: [1, 2, 3] }), {})!;

/** queryIPC calls held until `finish(sql)`; every call logged in `events`. */
function heldConnection() {
	const waiting = new Map<string, () => void>();
	const conn: DuckDBConnection = {
		async query() {
			throw new Error('not used: queryIPC is');
		},
		async queryIPC(sql: string) {
			events.push(`send ${sql}`);
			await new Promise<void>((r) => waiting.set(sql, r));
			return BYTES;
		},
		async exec(sql: string) {
			events.push(`send ${sql}`);
		},
		async close() {}
	};
	const finish = async (sql: string) => {
		await vi.waitFor(() => expect(waiting.has(sql)).toBe(true));
		waiting.get(sql)!();
		waiting.delete(sql);
	};
	return { conn, finish };
}

describe('QueryEngine main-connection queue', () => {
	it('sends the next statement when the bytes arrive, before decoding them', async () => {
		events.length = 0;
		const { conn, finish } = heldConnection();
		const engine = new QueryEngine(conn, { mainInFlightCap: 1 });
		const a = engine.query('SELECT 1', { cache: false });
		const b = engine.query('SELECT 2', { cache: false });
		await vi.waitFor(() => expect(events).toEqual(['send SELECT 1']));

		await finish('SELECT 1');
		await a;
		expect(events).toEqual(['send SELECT 1', 'send SELECT 2', 'decode']);
		await finish('SELECT 2');
		await b;
	});

	it('runs setup ahead of reads queued earlier, and records each rank', async () => {
		events.length = 0;
		const { conn, finish } = heldConnection();
		const engine = new QueryEngine(conn, { mainInFlightCap: 1 });
		const records: StatementRecord[] = [];
		engine.observeStatements((r) => records.push(r));

		const running = engine.query('SELECT running', { cache: false });
		await vi.waitFor(() => expect(events).toEqual(['send SELECT running']));
		const reads = [
			engine.query('SELECT requery', { cache: false, callerId: 'm1' }),
			engine.query('SELECT first', { cache: false, callerId: 'm2', rank: 1 }),
			engine.query('SELECT setup', { cache: false })
		];
		await finish('SELECT running');
		await finish('SELECT setup');
		await finish('SELECT first');
		await finish('SELECT requery');
		await Promise.all([running, ...reads]);

		expect(events.filter((e) => e.startsWith('send'))).toEqual([
			'send SELECT running',
			'send SELECT setup',
			'send SELECT first',
			'send SELECT requery'
		]);
		const bySql = Object.fromEntries(records.map((r) => [r.sql, r]));
		expect(bySql['SELECT setup'].rank).toBe(0);
		expect(bySql['SELECT first'].rank).toBe(1);
		expect(bySql['SELECT requery'].rank).toBe(2);
		// Held in JS, then on the connection.
		for (const r of records) expect(r.start).toBeGreaterThanOrEqual(r.queued);
		expect(bySql['SELECT setup'].start).toBeGreaterThan(bySql['SELECT setup'].queued);
	});

	it('ranks background work last', async () => {
		events.length = 0;
		const { conn, finish } = heldConnection();
		const engine = new QueryEngine(conn, { mainInFlightCap: 1 });
		const running = engine.query('SELECT running', { cache: false });
		await vi.waitFor(() => expect(events).toHaveLength(1));
		const background = engine.query('SELECT background', {
			cache: false,
			class: 'background',
			connectionLocal: true
		});
		const requery = engine.query('SELECT requery', { cache: false, callerId: 'm1' });
		await finish('SELECT running');
		await finish('SELECT requery');
		await finish('SELECT background');
		await Promise.all([running, background, requery]);
		expect(events.filter((e) => e.startsWith('send')).slice(1)).toEqual([
			'send SELECT requery',
			'send SELECT background'
		]);
	});

	it('cancelling a mark drops its read still queued in JS', async () => {
		events.length = 0;
		const { conn, finish } = heldConnection();
		const engine = new QueryEngine(conn, { mainInFlightCap: 1 });
		const running = engine.query('SELECT running', { cache: false });
		await vi.waitFor(() => expect(events).toHaveLength(1));
		// Caught now: it rejects while the test awaits the connection.
		const doomed = engine
			.query('SELECT doomed', { cache: false, callerId: 'm1' })
			.catch((e: unknown) => e);
		const next = engine.query('SELECT next', { cache: false });
		engine.cancel('m1');
		await finish('SELECT running');
		await finish('SELECT next');
		expect(await doomed).toMatchObject({ name: 'AbortError' });
		await Promise.all([running, next]);
		expect(events).not.toContain('send SELECT doomed');
	});
});
