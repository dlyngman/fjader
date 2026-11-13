import { describe, it, expect } from 'vitest';
import { QueryEngine } from '../QueryEngine';
import type { DuckDBConnection } from '../QueryEngine';
import { attachQueryLog } from './query-log';

const conn: DuckDBConnection = {
	async query() {
		return { numRows: 0, get: () => ({}) } as never;
	},
	async exec() {},
	async close() {}
};

describe('attachQueryLog', () => {
	it('records statements with their class, purpose and table, until detached', async () => {
		const engine = new QueryEngine(conn);
		const log = attachQueryLog(engine);
		await engine.query('SELECT min("x"), max("x") FROM "flights"', { cache: false });
		await engine.query('SELECT "x", count(*) FROM "flights" GROUP BY "x"', { cache: false });
		await engine.exec('DROP TABLE IF EXISTS "_tt_a"', { class: 'background' });
		log.detach();
		await engine.exec('SELECT 1');

		expect(log.statements.map((s) => [s.class, s.purpose, s.table])).toEqual([
			['interaction', 'range', 'flights'],
			['interaction', 'data', 'flights'],
			['background', 'ddl', '?']
		]);
		const quiet = console.log;
		const table = console.table;
		console.log = () => {};
		console.table = () => {};
		try {
			expect(log.report().reduce((n, r) => n + r.n, 0)).toBe(3);
		} finally {
			console.log = quiet;
			console.table = table;
		}
	});
});
