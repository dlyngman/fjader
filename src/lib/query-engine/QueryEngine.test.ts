import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryEngine, mapSqlTypeToJs } from './QueryEngine';
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

		it('accepts objects with toString()', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);

			const queryObj = { toString: () => 'SELECT 1 FROM t' };
			await engine.query(queryObj);
			expect(conn.queries).toEqual(['SELECT 1 FROM t']);
		});

		it('executes multiple queries sequentially', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);

			await engine.query('SELECT 1');
			await engine.query('SELECT 2');
			expect(conn.queries).toEqual(['SELECT 1', 'SELECT 2']);
		});

		it('accepts a Promise<DuckDBConnection> and defers until resolved', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(Promise.resolve(conn));

			await engine.query('SELECT 1');
			expect(conn.queries).toEqual(['SELECT 1']);
		});
	});

	describe('cancel-on-supersede', () => {
		it('queues second query as pending when first is inflight', async () => {
			const resolvers: Array<(v: unknown) => void> = [];

			const conn = createMockConnection({
				queryFn: () =>
					new Promise((resolve) => {
						resolvers.push(resolve);
					})
			});
			const engine = new QueryEngine(conn);

			// Start first query (goes inflight)
			const p1 = engine.query('SELECT 1', { callerId: 'mark-1' });

			// Second query for same caller — goes to pending slot (not inflight)
			const p2 = engine.query('SELECT 2', { callerId: 'mark-1' });

			// Only one query on the connection (first inflight)
			expect(resolvers).toHaveLength(1);

			// Resolve the inflight query — p1 succeeds, pending p2 starts
			resolvers[0]({ numRows: 0, get: () => ({}) });
			const r1 = await p1;
			expect(r1).toBeDefined();

			// Wait for pending query to reach the connection and resolve it
			await new Promise((r) => setTimeout(r, 0));
			expect(resolvers).toHaveLength(2);
			resolvers[1]({ numRows: 0, get: () => ({}) });

			const r2 = await p2;
			expect(r2).toBeDefined();
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

			// Simulate rapid filter changes (like brushing).
			// Execute-latest: first query goes inflight (completes instantly
			// with sync mock), all subsequent replace the pending slot.
			const promises = [];
			for (let i = 0; i < 10; i++) {
				promises.push(engine.query(`SELECT ${i}`, { callerId: 'mark-1' }).catch(() => 'aborted'));
			}

			const results = await Promise.all(promises);

			// First query succeeds (inflight, completes immediately).
			// Last query succeeds (pending, fires after first completes).
			// Intermediate queries are rejected from the pending slot.
			const succeeded = results.filter((r) => r !== 'aborted');
			expect(succeeded).toHaveLength(2);

			// Only 2 queries hit the connection
			expect(queryCount).toBe(2);
			expect(conn.queries[0]).toBe('SELECT 0');
			expect(conn.queries[1]).toBe('SELECT 9');
		});
	});

	describe('external signal without callerId', () => {
		it('rejects if signal is already aborted', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);
			const controller = new AbortController();
			controller.abort();

			await expect(engine.query('SELECT 1', { signal: controller.signal })).rejects.toThrow(
				'aborted'
			);
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

			await expect(engine.query('SELECT 1', { signal: controller.signal })).rejects.toThrow(
				'aborted'
			);
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
				queryFn: () =>
					new Promise((r) => {
						resolver = r;
					})
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

	describe('clearQueryCache()', () => {
		it('forces cached queries to re-hit the connection', async () => {
			const conn = createMockConnection();
			const engine = new QueryEngine(conn);

			await engine.query('SELECT 1', { callerId: 'mark-1' });
			await engine.query('SELECT 1', { callerId: 'mark-1' });
			expect(conn.queries).toEqual(['SELECT 1']); // second hit was a cache hit

			engine.clearQueryCache();

			await engine.query('SELECT 1', { callerId: 'mark-1' });
			expect(conn.queries).toEqual(['SELECT 1', 'SELECT 1']); // cache was cleared
		});

		it('also clears the DESCRIBE cache', async () => {
			const conn = createMockConnection({
				queryFn: (sql) =>
					sql.startsWith('DESCRIBE')
						? { numRows: 0, get: () => ({}) }
						: { numRows: 0, get: () => ({}) }
			});
			const engine = new QueryEngine(conn);

			await engine.describe('t');
			await engine.describe('t');
			expect(conn.queries).toEqual(['DESCRIBE "t"']); // second call was cached

			engine.clearQueryCache();

			await engine.describe('t');
			expect(conn.queries).toEqual(['DESCRIBE "t"', 'DESCRIBE "t"']); // cache was cleared
		});

		// The dims and views are dropped here, which invalidates the marks' SQL
		// and not just their results: their query parts name __dplot_*_idx
		// columns on a view that is now gone. Marks find that out through these
		// listeners and nowhere else.
		it('notifies identity reset listeners', async () => {
			const engine = new QueryEngine(createMockConnection());
			const seen: string[] = [];
			engine.onIdentityReset(() => seen.push('a'));
			engine.onIdentityReset(() => seen.push('b'));

			await engine.clearQueryCache();

			expect(seen).toEqual(['a', 'b']);
		});

		it('notifies before the returned promise resolves', async () => {
			const engine = new QueryEngine(createMockConnection());
			let notified = false;
			engine.onIdentityReset(() => {
				notified = true;
			});

			// The documented contract: awaiting clearQueryCache() means the
			// rebuild has been asked for, not merely scheduled.
			await engine.clearQueryCache();
			expect(notified).toBe(true);
		});

		it('stops notifying after unsubscribe', async () => {
			const engine = new QueryEngine(createMockConnection());
			let calls = 0;
			const off = engine.onIdentityReset(() => calls++);

			await engine.clearQueryCache();
			off();
			await engine.clearQueryCache();

			expect(calls).toBe(1);
		});

		it('still notifies the rest when one listener throws', async () => {
			const engine = new QueryEngine(createMockConnection());
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
			let reached = false;
			engine.onIdentityReset(() => {
				throw new Error('boom');
			});
			engine.onIdentityReset(() => {
				reached = true;
			});

			await engine.clearQueryCache();

			expect(reached).toBe(true);
			spy.mockRestore();
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
				queryFn: () =>
					new Promise((r) => {
						resolver = r;
					})
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

describe('mapSqlTypeToJs', () => {
	// Type names exactly as DESCRIBE reports them (checked against DuckDB 1.4).
	it.each([
		...['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT'].map((t) => [t, 'number']),
		...['UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'UHUGEINT'].map((t) => [t, 'number']),
		...['FLOAT', 'DOUBLE', 'DECIMAL(18,3)', 'BIGNUM'].map((t) => [t, 'number']),
		// The same type as reported by DuckDB before 1.4, including the installed DuckDB-WASM.
		['VARINT', 'number'],
		...['DATE', 'TIME', 'TIME WITH TIME ZONE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE'].map((t) => [
			t,
			'date'
		]),
		...['TIMESTAMP_S', 'TIMESTAMP_MS', 'TIMESTAMP_NS'].map((t) => [t, 'date']),
		['BOOLEAN', 'boolean'],
		...['VARCHAR', 'BLOB', 'UUID', 'BIT'].map((t) => [t, 'string'])
	])('%s → %s', (sqlType, jsType) => {
		expect(mapSqlTypeToJs(sqlType)).toBe(jsType);
	});

	// An ENUM's type string lists its members: INTERNATIONAL contains INT, UPDATED DATE.
	it('maps an ENUM to string whatever its members are', () => {
		expect(mapSqlTypeToJs("ENUM('DOMESTIC', 'INTERNATIONAL')")).toBe('string');
		expect(mapSqlTypeToJs("ENUM('NEW', 'UPDATED')")).toBe('string');
		expect(mapSqlTypeToJs("ENUM('TRUE_BOOL', 'FLOAT_ON')")).toBe('string');
	});

	it('maps nested types by their own name, not their fields', () => {
		expect(mapSqlTypeToJs('STRUCT(n INTEGER, at DATE)')).toBe('string');
		expect(mapSqlTypeToJs('MAP(VARCHAR, INTEGER)')).toBe('string');
		expect(mapSqlTypeToJs('UNION(n INTEGER)')).toBe('string');
	});

	// None of these can be cast to REAL, which is what 'number' leads to.
	it('maps lists, arrays, intervals and names merely containing INT to string', () => {
		expect(mapSqlTypeToJs('INTEGER[]')).toBe('string');
		expect(mapSqlTypeToJs('INTEGER[2]')).toBe('string');
		expect(mapSqlTypeToJs('INTERVAL')).toBe('string');
		expect(mapSqlTypeToJs('POINT_2D')).toBe('string');
	});
});
