import { describe, it, expect } from 'vitest';
import { QueryEngine } from './QueryEngine';
import type { DuckDBConnection, StatementRecord } from './QueryEngine';

/**
 * Every statement reaches the connection through one funnel (#send), which
 * statement observers see, with the class its caller gave it.
 */
function fakeConnection(failOn?: string) {
	const sent: string[] = [];
	const conn: DuckDBConnection = {
		async query(sql: string) {
			sent.push(sql);
			if (failOn && sql.includes(failOn)) throw new Error('boom');
			const rows = sql.startsWith('DESCRIBE')
				? [{ column_name: 'a', column_type: 'INTEGER', null: 'YES' }]
				: [];
			return { numRows: rows.length, get: (i: number) => rows[i] } as never;
		},
		async exec(sql: string) {
			sent.push(sql);
			if (failOn && sql.includes(failOn)) throw new Error('boom');
		},
		async insertArrowFromIPCStream() {
			sent.push('insert');
		},
		async close() {}
	};
	return { conn, sent };
}

function observe(engine: QueryEngine) {
	const records: StatementRecord[] = [];
	const off = engine.observeStatements((r) => records.push(r));
	return { records, off };
}

describe('QueryEngine #send funnel', () => {
	it('sends queries, statements, DESCRIBE and Arrow inserts through the observer', async () => {
		const { conn } = fakeConnection();
		const engine = new QueryEngine(conn);
		const { records } = observe(engine);

		await engine.query('SELECT 1', { cache: false });
		await engine.exec(['CREATE TABLE t (a INT)', 'DROP TABLE t']);
		await engine.describe('t');
		await engine.insertArrowFromIPCStream(new Uint8Array(8), { name: 't', create: true });

		expect(records.map((r) => [r.kind, r.sql])).toEqual([
			['query', 'SELECT 1'],
			['exec', 'CREATE TABLE t (a INT)'],
			['exec', 'DROP TABLE t'],
			['describe', 'DESCRIBE "t"'],
			['insert', 'INSERT ARROW INTO "t" (8 bytes)']
		]);
		for (const r of records) expect(r.end).toBeGreaterThanOrEqual(r.start);
	});

	it("defaults to 'interaction' and carries a caller's class", async () => {
		const { conn } = fakeConnection();
		const engine = new QueryEngine(conn);
		const { records } = observe(engine);

		await engine.query('SELECT 1', { cache: false });
		await engine.query('SELECT 2', { cache: false, class: 'background' });
		await engine.query('SELECT 3', { callerId: 'mark-1', cache: false, class: 'background' });
		await engine.exec('CREATE TABLE b (a INT)', { class: 'background' });

		expect(records.map((r) => r.class)).toEqual([
			'interaction',
			'background',
			'background',
			'background'
		]);
	});

	it('records a failed statement and still rejects', async () => {
		const { conn } = fakeConnection('broken');
		const engine = new QueryEngine(conn);
		const { records } = observe(engine);

		await expect(engine.exec('SELECT broken')).rejects.toThrow('boom');
		expect(records).toHaveLength(1);
		expect(String(records[0].error)).toContain('boom');
	});

	it('stops calling an observer once it unsubscribes', async () => {
		const { conn } = fakeConnection();
		const engine = new QueryEngine(conn);
		const { records, off } = observe(engine);

		await engine.exec('SELECT 1');
		off();
		await engine.exec('SELECT 2');
		expect(records).toHaveLength(1);
	});

	it('waits for a connection given as a promise', async () => {
		const { conn, sent } = fakeConnection();
		let resolve!: (c: DuckDBConnection) => void;
		const engine = new QueryEngine(new Promise<DuckDBConnection>((r) => (resolve = r)));
		const done = engine.exec('CREATE TABLE late (a INT)');
		resolve(conn);
		await done;
		expect(sent).toEqual(['CREATE TABLE late (a INT)']);
	});
});
