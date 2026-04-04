/**
 * QueryEngine v1-v2 — thin DuckDB-WASM wrapper with cancel-on-supersede.
 *
 * The mark layer's only interface to DuckDB. All query execution goes through
 * queryEngine.query(sql, opts). Batching, caching, and priority are internal —
 * marks never manage cancellation tokens or think about query scheduling.
 *
 * v1: Direct execution (await connection.query(sql))
 * v2: Cancel-on-supersede — keyed on callerId, drops stale in-flight queries.
 *     Note: DuckDB-WASM doesn't support aborting in-flight queries, so "cancel"
 *     means the result is discarded (the DuckDB work still completes). This
 *     prevents stale results from being applied but doesn't save compute.
 *
 * Future layers (cache, batching, PreAggregator) add capabilities without
 * changing the external interface.
 */

import type { Table } from '@uwdata/flechette';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryOpts {
	/** Caller identifier for cancel-on-supersede. When a new query arrives
	 *  for the same callerId, any in-flight query for that caller is cancelled. */
	callerId?: string;
	/** AbortSignal for external cancellation. */
	signal?: AbortSignal;
}

export interface ColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
}

/**
 * Minimal connection interface matching DuckDB-WASM's AsyncDuckDBConnection.
 * Allows testing with a mock connection.
 */
export interface DuckDBConnection {
	query(sql: string): Promise<Table>;
	/** DDL/DML execution without Arrow deserialization overhead.
	 *  Falls back to query() if not provided. */
	exec?(sql: string): Promise<void>;
	close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export class QueryEngine {
	#conn: DuckDBConnection;
	#inflight = new Map<string, AbortController>();
	#pending = new Map<string, { sql: string; resolve: (t: Table) => void; reject: (e: Error) => void }>();
	#destroyed = false;

	constructor(connection: DuckDBConnection) {
		this.#conn = connection;
	}

	/**
	 * Execute a query and return the Arrow result table.
	 * Accepts a SQL string or any object with toString() (e.g. mosaic-sql Query).
	 *
	 * If callerId is provided, uses execute-latest semantics: at most one
	 * query is inflight per caller, plus one pending. New queries while
	 * inflight replace the pending slot (the connection isn't blocked with
	 * a queue of queries that will all be discarded anyway).
	 */
	async query(sql: string | { toString(): string }, opts?: QueryOpts): Promise<Table> {
		if (this.#destroyed) {
			throw new Error('QueryEngine has been destroyed');
		}

		const sqlStr = typeof sql === 'string' ? sql : sql.toString();

		if (opts?.callerId) {
			const callerId = opts.callerId;

			// Execute-latest: at most 1 inflight + 1 pending per caller.
			// Don't abort inflight — let it complete and show its result for
			// continuous visual updates during brushing. Only collapse the
			// pending slot so we don't pile up queries on the connection.
			if (this.#inflight.has(callerId)) {
				// Reject any existing pending query for this caller
				const prev = this.#pending.get(callerId);
				if (prev) {
					prev.reject(new DOMException('Query superseded', 'AbortError'));
				}
				// Store as pending — will be executed when inflight completes
				return new Promise<Table>((resolve, reject) => {
					this.#pending.set(callerId, { sql: sqlStr, resolve, reject });
				});
			}

			return this.#executeForCaller(callerId, sqlStr, opts.signal);
		}

		// No callerId: direct execution, still respect external signal
		if (opts?.signal) {
			if (opts.signal.aborted) {
				throw new DOMException('Query aborted', 'AbortError');
			}
			const result = await this.#conn.query(sqlStr);
			if (opts.signal.aborted) {
				throw new DOMException('Query aborted', 'AbortError');
			}
			return result;
		}

		return this.#conn.query(sqlStr);
	}

	async #executeForCaller(callerId: string, sqlStr: string, signal?: AbortSignal): Promise<Table> {
		const controller = new AbortController();
		this.#inflight.set(callerId, controller);

		if (signal) {
			signal.addEventListener('abort', () => controller.abort(), { once: true });
		}

		try {
			if (controller.signal.aborted) {
				throw new DOMException('Query superseded', 'AbortError');
			}

			const result = await this.#conn.query(sqlStr);

			if (controller.signal.aborted) {
				throw new DOMException('Query superseded', 'AbortError');
			}

			return result;
		} finally {
			// Only clean up if we're still the current query for this caller
			const current = this.#inflight.get(callerId);
			if (current === controller) {
				this.#inflight.delete(callerId);
			}

			// If there's a pending query for this caller, execute it now
			const pending = this.#pending.get(callerId);
			if (pending) {
				this.#pending.delete(callerId);
				this.#executeForCaller(callerId, pending.sql, undefined)
					.then(pending.resolve)
					.catch(pending.reject);
			}
		}
	}

	/**
	 * Execute DDL/DML statements (CREATE TABLE, DROP TABLE, INSERT, etc.).
	 * Accepts a single SQL string or an array of statements to execute
	 * sequentially.
	 */
	async exec(sql: string | string[]): Promise<void> {
		if (this.#destroyed) {
			throw new Error('QueryEngine has been destroyed');
		}
		const statements = Array.isArray(sql) ? sql : [sql];
		const execFn = this.#conn.exec?.bind(this.#conn);
		for (const stmt of statements) {
			if (execFn) {
				await execFn(stmt);
			} else {
				await this.#conn.query(stmt);
			}
		}
	}

	/**
	 * Get column info for a table via DESCRIBE.
	 * Replaces Mosaic's queryFieldInfo for type introspection.
	 */
	async describe(table: string): Promise<ColumnInfo[]> {
		if (this.#destroyed) {
			throw new Error('QueryEngine has been destroyed');
		}
		const escaped = table.replaceAll('"', '""');
		const result = await this.#conn.query(`DESCRIBE "${escaped}"`);
		const columns: ColumnInfo[] = [];
		for (let i = 0; i < result.numRows; i++) {
			const row = result.get(i);
			columns.push({
				name: (row as Record<string, unknown>).column_name as string,
				type: (row as Record<string, unknown>).column_type as string,
				nullable: (row as Record<string, unknown>).null !== 'NO'
			});
		}
		return columns;
	}

	/**
	 * Check if a previous query for this callerId is still in-flight.
	 */
	isInflight(callerId: string): boolean {
		return this.#inflight.has(callerId);
	}

	/**
	 * Cancel any in-flight or pending query for the given callerId.
	 */
	cancel(callerId: string): void {
		const controller = this.#inflight.get(callerId);
		if (controller) {
			controller.abort();
			this.#inflight.delete(callerId);
		}
		const pending = this.#pending.get(callerId);
		if (pending) {
			pending.reject(new DOMException('Query cancelled', 'AbortError'));
			this.#pending.delete(callerId);
		}
	}

	/**
	 * Destroy the engine and close the connection.
	 */
	async destroy(): Promise<void> {
		this.#destroyed = true;
		for (const controller of this.#inflight.values()) {
			controller.abort();
		}
		this.#inflight.clear();
		for (const pending of this.#pending.values()) {
			pending.reject(new DOMException('Engine destroyed', 'AbortError'));
		}
		this.#pending.clear();
		await this.#conn.close();
	}
}
