import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryEngine } from './QueryEngine';
import type { DuckDBConnection } from './QueryEngine';

// ---------------------------------------------------------------------------
// Mock connection
// ---------------------------------------------------------------------------

function createMockConnection(opts?: {
	queryDelay?: number;
	queryFn?: (sql: string) => unknown;
}): DuckDBConnection & { queries: string[] } {
	const queries: string[] = [];
	const delay = opts?.queryDelay ?? 0;
	const queryFn = opts?.queryFn;

	return {
		queries,
		async query(sql: string) {
			queries.push(sql);
			if (delay > 0) {
				await new Promise((r) => setTimeout(r, delay));
			}
			if (queryFn) {
				return queryFn(sql) as any;
			}
			// Return a minimal Arrow-like table mock
			return {
				numRows: 0,
				get: () => ({})
			} as any;
		},
		async close() {
			// no-op
		}
	};
}

describe('QueryEngine', () => {
	describe('query()', () => {
		it('executes a simple query', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);

			await engine.query('SELECT 1');
			expect(conn.queries).toEqual(['SELECT 1']);
		});

		it('executes multiple queries sequentially', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);

			await engine.query('SELECT 1');
			await engine.query('SELECT 2');
			expect(conn.queries).toEqual(['SELECT 1', 'SELECT 2']);
		});
	});

	describe('cancel-on-supersede', () => {
		it('aborts previous query for same callerId', async () => {
			let resolvers: Array<(v: unknown) => void> = [];

			const conn = createMockConnection({
				queryFn: () =>
					new Promise((resolve) => {
						resolvers.push(resolve);
					})
			});
			const engine = new QueryEngine(conn);

			// Start first query
			const p1 = engine.query('SELECT 1', { callerId: 'mark-1' });

			// Start second query for same caller — should supersede first
			const p2 = engine.query('SELECT 2', { callerId: 'mark-1' });

			// Resolve both connection queries
			resolvers[0]({ numRows: 0, get: () => ({}) });
			resolvers[1]({ numRows: 0, get: () => ({}) });

			// First query should reject with AbortError
			await expect(p1).rejects.toThrow('superseded');

			// Second query should succeed
			await expect(p2).resolves.toBeDefined();
		});

		it('does not interfere with different callerIds', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);

			const [r1, r2] = await Promise.all([
				engine.query('SELECT 1', { callerId: 'mark-1' }),
				engine.query('SELECT 2', { callerId: 'mark-2' })
			]);

			expect(r1).toBeDefined();
			expect(r2).toBeDefined();
			expect(conn.queries).toEqual(['SELECT 1', 'SELECT 2']);
		});

		it('cleans up inflight tracking after completion', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);

			await engine.query('SELECT 1', { callerId: 'mark-1' });
			expect(engine.isInflight('mark-1')).toBe(false);
		});

		it('handles rapid successive queries (simulated brushing)', async () => {
			let queryCount = 0;
			const conn = createMockConnection({
				queryFn: () => {
					queryCount++;
					return { numRows: 0, get: () => ({}) };
				}
			});
			const engine = new QueryEngine(conn);

			// Simulate rapid filter changes (like brushing)
			const promises = [];
			for (let i = 0; i < 10; i++) {
				promises.push(
					engine
						.query(`SELECT ${i}`, { callerId: 'mark-1' })
						.catch(() => 'aborted')
				);
			}

			const results = await Promise.all(promises);

			// Only the last query should succeed
			const succeeded = results.filter((r) => r !== 'aborted');
			expect(succeeded).toHaveLength(1);

			// All queries were sent to the connection (sync, no delay)
			expect(queryCount).toBe(10);
		});
	});

	describe('external signal without callerId', () => {
		it('rejects if signal is already aborted', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);
			const controller = new AbortController();
			controller.abort();

			await expect(
				engine.query('SELECT 1', { signal: controller.signal })
			).rejects.toThrow('aborted');
			expect(conn.queries).toEqual([]);
		});

		it('rejects if signal is aborted while awaiting', async () => {
			const controller = new AbortController();
			const conn = createMockConnection({
				queryFn: () => {
					// Abort during the query
					controller.abort();
					return { numRows: 0, get: () => ({}) };
				}
			});
			const engine = new QueryEngine(conn);

			await expect(
				engine.query('SELECT 1', { signal: controller.signal })
			).rejects.toThrow('aborted');
		});

		it('succeeds if signal is never aborted', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);
			const controller = new AbortController();

			const result = await engine.query('SELECT 1', { signal: controller.signal });
			expect(result).toBeDefined();
		});
	});

	describe('cancel()', () => {
		it('cancels an in-flight query by callerId', async () => {
			let resolver: ((v: unknown) => void) | null = null;
			const conn = createMockConnection({
				queryFn: () => new Promise((r) => { resolver = r; })
			});
			const engine = new QueryEngine(conn);

			const p = engine.query('SELECT 1', { callerId: 'mark-1' });
			expect(engine.isInflight('mark-1')).toBe(true);

			engine.cancel('mark-1');
			expect(engine.isInflight('mark-1')).toBe(false);

			// Resolve the connection query
			resolver!({ numRows: 0, get: () => ({}) });

			// Query should reject
			await expect(p).rejects.toThrow('superseded');
		});
	});

	describe('exec()', () => {
		it('executes a single DDL statement', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);

			await engine.exec('CREATE TABLE t (x INT)');
			expect(conn.queries).toEqual(['CREATE TABLE t (x INT)']);
		});

		it('executes multiple DDL statements sequentially', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);

			await engine.exec([
				'DROP TABLE IF EXISTS t',
				'CREATE TABLE t (x INT)',
				'INSERT INTO t VALUES (1)'
			]);
			expect(conn.queries).toEqual([
				'DROP TABLE IF EXISTS t',
				'CREATE TABLE t (x INT)',
				'INSERT INTO t VALUES (1)'
			]);
		});
	});

	describe('describe()', () => {
		it('escapes table names with double quotes', async () => {
			const conn = createMockConnection({
				queryFn: () => ({ numRows: 0, get: () => ({}) })
			});
			const engine = new QueryEngine(conn);

			await engine.describe('table"injection');
			expect(conn.queries).toEqual(['DESCRIBE "table""injection"']);
		});

		it('returns column info from DESCRIBE', async () => {
			const conn = createMockConnection({
				queryFn: (sql) => {
					if (sql.startsWith('DESCRIBE')) {
						return {
							numRows: 2,
							get: (i: number) =>
								i === 0
									? { column_name: 'x', column_type: 'INTEGER', null: 'YES' }
									: { column_name: 'name', column_type: 'VARCHAR', null: 'NO' }
						};
					}
					return { numRows: 0, get: () => ({}) };
				}
			});
			const engine = new QueryEngine(conn);

			const columns = await engine.describe('test_table');
			expect(columns).toEqual([
				{ name: 'x', type: 'INTEGER', nullable: true },
				{ name: 'name', type: 'VARCHAR', nullable: false }
			]);
		});
	});

	describe('destroy()', () => {
		it('rejects queries after destroy', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);

			await engine.destroy();
			await expect(engine.query('SELECT 1')).rejects.toThrow('destroyed');
		});

		it('cancels in-flight queries on destroy', async () => {
			let resolver: ((v: unknown) => void) | null = null;
			const conn = createMockConnection({
				queryFn: () => new Promise((r) => { resolver = r; })
			});
			const engine = new QueryEngine(conn);

			const p = engine.query('SELECT 1', { callerId: 'mark-1' });
			await engine.destroy();

			// Resolve connection query
			resolver!({ numRows: 0, get: () => ({}) });

			await expect(p).rejects.toThrow('superseded');
		});
	});
});
