/**
 * QueryEngine v1-v3 — DuckDB-WASM wrapper with cancel-on-supersede and
 * mark registration for batch filter-driven re-queries.
 *
 * The mark layer's only interface to DuckDB. All query execution goes through
 * queryEngine.query(sql, opts) for ad-hoc queries, or registerMark() +
 * onFilterChange() for the reactive registration path.
 *
 * v1: Direct execution (await connection.query(sql))
 * v2: Cancel-on-supersede — keyed on callerId, drops stale in-flight queries.
 *     Note: DuckDB-WASM doesn't support aborting in-flight queries, so "cancel"
 *     means the result is discarded (the DuckDB work still completes). This
 *     prevents stale results from being applied but doesn't save compute.
 * v3: Mark registration — marks register structural query descriptors with the
 *     engine. Filter changes fan through the engine as a single imperative batch
 *     instead of N independent reactive chains. Preagg routing for aggregated
 *     marks during brushing.
 */

import { tableFromIPC, type Table } from '@uwdata/flechette';
export type { BrushActivation } from './sufficient-statistics';
import {
	assembleQuery,
	castNumeric,
	splitWindowSelect,
	type QueryParts
} from '$lib/components/marks/lifecycle/query-builder';
import { Preagg } from './preagg/Preagg';
import type { ActivationSource } from './preagg/plan';
export type { ActiveDim, ActivationSource } from './preagg/plan';
import { MarkHandle, type QueryParams } from './MarkHandle.svelte';
import {
	CategoricalIdentity,
	type DimValue,
	type FieldIdentity,
	type IdentityField
} from './categorical-identity';
import type { FilterGroup } from './FilterGroup.svelte';
import type { TransformCompiler } from '$lib/transforms/TransformCompiler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryOpts {
	/** Caller identifier for cancel-on-supersede. When a new query arrives
	 *  for the same callerId, any in-flight query for that caller is cancelled. */
	callerId?: string;
	/** AbortSignal for external cancellation. */
	signal?: AbortSignal;
	/** Enable query result caching. Default true. Set false for queries against
	 *  volatile temp tables whose contents change without the SQL changing. */
	cache?: boolean;
}

/**
 * How long a queued build waits behind mark queries before it is sent anyway,
 * by default. During a drag on the base table a mark query is always waiting
 * (each one takes longer than a frame), so without a limit the build that
 * would make the drag fast never runs. Past it, one frame waits behind the
 * build instead.
 */
const BUILD_MAX_WAIT_MS = 100;

export interface QueryEngineOptions {
	/** Overrides BUILD_MAX_WAIT_MS; tests use it to make the queue deterministic. */
	buildMaxWaitMs?: number;
}

// outerAggBuilders + window CTE wrapping now live in query-builder.ts
// (splitWindowSelect / buildOuterWindow / assembleQuery) so the base path,
// preagg path, and sufficient-statistics analysis share one implementation.

export interface ColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
}

export type JsColumnType = 'number' | 'string' | 'date' | 'boolean';

// DESCRIBE reports canonical type names, so these match exactly. Anything else (VARCHAR,
// ENUM, lists, STRUCT, INTERVAL, extension types) is a string, which is never cast to REAL.
const NUMBER_TYPES = new Set([
	'TINYINT',
	'SMALLINT',
	'INTEGER',
	'BIGINT',
	'HUGEINT',
	'UTINYINT',
	'USMALLINT',
	'UINTEGER',
	'UBIGINT',
	'UHUGEINT',
	'FLOAT',
	'DOUBLE',
	'DECIMAL',
	'BIGNUM',
	// BIGNUM's name before DuckDB 1.4: the installed DuckDB-WASM (1.3.2) and a Python
	// server's native DuckDB older than 1.4 still report it.
	'VARINT'
]);
const DATE_TYPES = new Set([
	'DATE',
	'TIME',
	'TIME WITH TIME ZONE',
	'TIMESTAMP',
	'TIMESTAMP WITH TIME ZONE',
	'TIMESTAMP_S',
	'TIMESTAMP_MS',
	'TIMESTAMP_NS'
]);

/** Map a DuckDB SQL type, as DESCRIBE reports it, to a JS type category. */
export function mapSqlTypeToJs(sqlType: string): JsColumnType {
	// The name without parameters: DECIMAL(18,3) → DECIMAL, ENUM('a', 'b') → ENUM.
	const name = (sqlType || '').toUpperCase().split('(')[0];
	if (NUMBER_TYPES.has(name)) return 'number';
	if (DATE_TYPES.has(name)) return 'date';
	if (name === 'BOOLEAN') return 'boolean';
	return 'string';
}

export interface ColumnSchema {
	sqlType: string;
	jsType: JsColumnType;
}

/** Build a schema map from ColumnInfo[] with JS type mapping. */
export function buildSchemaMap(columns: ColumnInfo[]): Map<string, ColumnSchema> {
	const map = new Map<string, ColumnSchema>();
	for (const col of columns) {
		map.set(col.name, { sqlType: col.type, jsType: mapSqlTypeToJs(col.type) });
	}
	return map;
}

/**
 * Minimal connection interface.
 * Supports two query paths:
 * - queryIPC (fast): returns raw Arrow IPC bytes, decoded by flechette (zero-copy)
 * - query (fallback): returns a Table directly (for mocks/testing)
 */
export interface DuckDBConnection {
	/** Fast path: raw Arrow IPC bytes → flechette tableFromIPC → zero-copy typed arrays. */
	queryIPC?(sql: string): Promise<Uint8Array>;
	/** Fallback query path. Used when queryIPC is not available (mocks, testing). */
	query(sql: string): Promise<Table>;
	/** DDL/DML execution without Arrow deserialization overhead.
	 *  Falls back to query() if not provided. */
	exec?(sql: string): Promise<void>;
	close(): Promise<void>;
	/** DuckDB-WASM specific: load Arrow IPC data as a named table. */
	insertArrowFromIPCStream?(
		data: Uint8Array,
		options: { name: string; create: boolean }
	): Promise<void>;
}

// ---------------------------------------------------------------------------
// v3 Registration types
// ---------------------------------------------------------------------------

export interface QueryDescriptor {
	/** The table the mark queries: its identity view when it has categorical channels. */
	table: string;
	/** The table the mark was configured with, never the view. Identity dims record base tables. */
	baseTable: string;
	parts: QueryParts;
	schema: Map<string, ColumnSchema>;
	transformCompiler: TransformCompiler;
}

interface MarkRegistration {
	descriptor: QueryDescriptor;
	handle: MarkHandle;
	filterGroup: FilterGroup;
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export class QueryEngine {
	#conn: DuckDBConnection | null = null;
	#connPromise: Promise<DuckDBConnection> | null = null;
	#inflight = new Map<string, AbortController>();
	#pending = new Map<
		string,
		{ sql: string; resolve: (t: Table) => void; reject: (e: Error) => void; cache: boolean }
	>();
	#describeCache = new Map<string, Promise<ColumnInfo[]>>();
	#marks = new Map<string, MarkRegistration>();
	#destroyed = false;
	/** Each mark's preagg tables, the build queue and the size guard (see Preagg). */
	#preagg: Preagg;
	/** When a filter last changed, in any group (performance.now()). */
	#lastFilterChangeAt = 0;
	/** LRU query cache: SQL string → Arrow Table (or Promise<Table> while inflight). */
	#queryCache = lruCache<Table>({ max: 1000, ttl: 3 * 60 * 60 * 1000 });
	/**
	 * Per-instance suffix for every table and view this engine creates.
	 * Multiple render contexts (Streamlit iframes, notebook cells) can share one
	 * DuckDB instance, and a competing instance rebuilding a dim would renumber
	 * ids already baked into live vertex buffers.
	 */
	#session = Math.random().toString(36).slice(2, 8);
	/** Categorical identity: dim tables, per-table views, id columns, labels. */
	#identity = new CategoricalIdentity(
		{
			exec: (sql) => this.exec(sql),
			queryRows: async (sql) => {
				// Never cached: the dim grows as tables register, and the SQL text
				// does not change when it does.
				const table = await this.query(sql, { cache: false });
				const rows: Array<Record<string, unknown>> = [];
				for (let i = 0; i < table.numRows; i++) {
					rows.push(table.get(i) as Record<string, unknown>);
				}
				return rows;
			}
		},
		this.#session
	);
	/** Notified after clearQueryCache() drops the identity dims and views. */
	#identityResetListeners = new Set<() => void>();

	constructor(
		connection: DuckDBConnection | Promise<DuckDBConnection>,
		options: QueryEngineOptions = {}
	) {
		this.#preagg = new Preagg(
			{
				exec: (sql) => this.exec(sql),
				query: (sql, opts) => this.query(sql, opts),
				busy: () => this.#inflight.size > 0 || this.#pending.size > 0,
				identity: this.#identity,
				mark: (markId) => this.#marks.get(markId),
				marks: () => this.#marks
			},
			options.buildMaxWaitMs ?? BUILD_MAX_WAIT_MS
		);
		if (connection instanceof Promise) {
			this.#connPromise = connection;
			connection.then((c) => {
				this.#conn = c;
			});
		} else {
			this.#conn = connection;
		}
	}

	/** This engine's per-instance suffix for created tables and views. */
	get session(): string {
		return this.#session;
	}

	/**
	 * Ensure `table` has a view exposing a stable numeric id column for each
	 * named categorical field, and resolve once it does. Concurrent callers
	 * coalesce into one rebuild. See `categorical-identity.ts`.
	 *
	 * EVERY categorical channel reads these columns: band and point positional
	 * axes, the facet grid, ordinal colour and the series scale that shares its
	 * class. Each selects the id column and keeps ids as its internal
	 * representation; display position is resolved from the shared identity slot
	 * table, on the GPU or through the scale's own lookup. There is no second
	 * path — the CASE inlining this replaced is deleted (`c54c53d`).
	 */
	ensureColumns(
		table: string,
		fields: { categorical?: (string | IdentityField)[] }
	): Promise<void> {
		if (this.#destroyed) {
			throw new Error('QueryEngine has been destroyed');
		}
		return this.#identity.ensureColumns(table, fields);
	}

	/** The view carrying id columns for `table`, or `table` if it has none. */
	identitySourceFor(table: string): string {
		return this.#identity.sourceFor(table);
	}

	/**
	 * SQL producing `field`'s value as its identity records it: a quoted column, or
	 * an expression's own text. Null until a mark has registered the field.
	 */
	identitySqlFor(field: string): string | null {
		return this.#identity.sqlFor(field) ?? null;
	}

	/** Whether `field`'s dim covers every non-NULL value of base table `table`. */
	identityCovers(field: string, table: string): boolean {
		return this.#identity.dimCovers(field, table);
	}

	/** Whether `table`'s identity view already exposes `field`'s id column. */
	identityViewHas(table: string, field: string): boolean {
		return this.#identity.viewHas(table, field);
	}

	/** The id column name a view exposes for `field`. */
	identityColumn(field: string): string {
		return this.#identity.idColumn(field);
	}

	/**
	 * The dim table holding `field`'s `(value, label, id)` rows.
	 *
	 * Exposed for callers that need to JOIN the dim rather than read an id
	 * column through a view — a dense result with one row per category, so a
	 * category leaving a topN still has a row to animate out on. The name is
	 * session-suffixed and owned by the identity coordinator; do not rebuild it
	 * from the field name.
	 */
	dimTableFor(field: string): string {
		return this.#identity.dimTable(field);
	}

	/**
	 * Dim values for `field`, indexed by id — the decode side of the string -> id
	 * encode. Not display labels: formatting belongs to the scale/axis layer.
	 *
	 * The LIVE array — hold the reference, do not snapshot it. A second table
	 * registering the same field appends to the dim afterwards and this array
	 * grows in place.
	 */
	identityValues(field: string): DimValue[] {
		return this.#identity.values(field);
	}

	/**
	 * The field's id <-> value bijection. One live object owning both
	 * directions, so a holder cannot end up with a value array and a reverse map
	 * that disagree. Prefer this over identityValues() anywhere the reverse
	 * direction is needed; do not rebuild it locally.
	 */
	identityFor(field: string): FieldIdentity {
		return this.#identity.identity(field);
	}

	/**
	 * Reserve an id for a value present in no table — the synthetic "Other"
	 * bucket from `topN({ includeOthers })`. Call after ensureColumns.
	 * Returns an existing id when a real category already carries the label.
	 */
	reserveSyntheticIdentity(field: string, label: string): Promise<number> {
		return this.#identity.reserveSynthetic(field, label);
	}

	/**
	 * Subscribe to identity resets. Returns an unsubscribe function.
	 *
	 * A mark that requested identity columns cannot survive one on its own: its
	 * query parts name `__dplot_*_idx` columns on a view that has just been
	 * dropped, and it has no way to notice. Listeners are how it finds out, and
	 * the contract is that a listener re-runs the mark's setup — re-requesting
	 * the columns rebuilds the dims against the reloaded data.
	 *
	 * Fired after the DROPs settle, and fired even if they failed: a partially
	 * dropped state still invalidates every id handed out before it.
	 */
	onIdentityReset(listener: () => void): () => void {
		this.#identityResetListeners.add(listener);
		return () => this.#identityResetListeners.delete(listener);
	}

	#notifyIdentityReset(): void {
		// Copied, so a listener unsubscribing during the sweep cannot skip a peer.
		for (const listener of [...this.#identityResetListeners]) {
			try {
				listener();
			} catch (error) {
				console.error('[QueryEngine] Identity reset listener failed:', error);
			}
		}
	}

	/**
	 * Execute a SQL query and return a flechette Table.
	 * Uses the fast IPC path (queryIPC → tableFromIPC) when available,
	 * falling back to the standard conn.query() for mocks/testing.
	 */
	async #queryRaw(sql: string): Promise<Table> {
		const conn = this.#conn!;
		if (conn.queryIPC) {
			const ipc = await conn.queryIPC(sql);
			return tableFromIPC(ipc);
		}
		return conn.query(sql);
	}

	/** Resolve #conn from #connPromise if needed. No-op when already resolved. */
	#ensureConnection(): Promise<void> | void {
		if (this.#conn) return;
		if (this.#connPromise) {
			return this.#connPromise.then((c) => {
				this.#conn = c;
			});
		}
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
		if (!this.#conn) await this.#ensureConnection();

		const sqlStr = typeof sql === 'string' ? sql : sql.toString();

		// Cache check: return cached result immediately, bypassing
		// inflight/pending bookkeeping entirely.
		// Opt out with cache: false for queries against volatile temp tables.
		const useCache = opts?.cache !== false;
		if (useCache) {
			const cached = this.#queryCache.get(sqlStr);
			if (cached !== undefined) {
				return cached instanceof Promise ? cached : Promise.resolve(cached);
			}
		}

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
					this.#pending.set(callerId, { sql: sqlStr, resolve, reject, cache: useCache });
				});
			}

			return this.#executeForCaller(callerId, sqlStr, opts.signal, useCache);
		}

		// No callerId: direct execution, still respect external signal
		if (opts?.signal) {
			if (opts.signal.aborted) {
				throw new DOMException('Query aborted', 'AbortError');
			}
			const result = await this.#queryRaw(sqlStr);
			if (opts.signal.aborted) {
				throw new DOMException('Query aborted', 'AbortError');
			}
			return result;
		}

		return this.#queryRaw(sqlStr);
	}

	async #executeForCaller(
		callerId: string,
		sqlStr: string,
		signal?: AbortSignal,
		cache: boolean = true
	): Promise<Table> {
		const controller = new AbortController();
		this.#inflight.set(callerId, controller);

		if (signal) {
			signal.addEventListener('abort', () => controller.abort(), { once: true });
		}

		try {
			if (controller.signal.aborted) {
				throw new DOMException('Query superseded', 'AbortError');
			}

			// Cache the Promise so concurrent identical queries share one inflight
			const queryPromise = this.#queryRaw(sqlStr);
			if (cache) this.#queryCache.set(sqlStr, queryPromise);

			const result = await queryPromise;

			// Replace Promise with resolved data for future lookups
			if (cache) this.#queryCache.set(sqlStr, result);

			if (controller.signal.aborted) {
				// Don't cache results from aborted queries
				this.#queryCache.delete(sqlStr);
				throw new DOMException('Query superseded', 'AbortError');
			}

			return result;
		} catch (e) {
			// Remove failed query from cache so we don't serve a rejected Promise
			this.#queryCache.delete(sqlStr);
			throw e;
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
				this.#executeForCaller(callerId, pending.sql, undefined, pending.cache)
					.then(pending.resolve)
					.catch(pending.reject);
			}
			// The last mark query settling frees the connection for a build.
			this.#preagg.pump();
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
		if (!this.#conn) await this.#ensureConnection();
		const statements = Array.isArray(sql) ? sql : [sql];
		const execFn = this.#conn!.exec?.bind(this.#conn!);
		for (const stmt of statements) {
			if (execFn) {
				await execFn(stmt);
			} else {
				await this.#conn!.query(stmt);
			}
		}
	}

	/**
	 * Get column info for a table via DESCRIBE.
	 * Results are cached — same table returns the same promise.
	 */
	describe(table: string): Promise<ColumnInfo[]> {
		if (this.#destroyed) {
			throw new Error('QueryEngine has been destroyed');
		}
		const cached = this.#describeCache.get(table);
		if (cached) return cached;

		const promise = this.#fetchDescribe(table);
		this.#describeCache.set(table, promise);
		return promise;
	}

	async #fetchDescribe(table: string): Promise<ColumnInfo[]> {
		if (!this.#conn) await this.#ensureConnection();
		const escaped = table.replaceAll('"', '""');
		const result = await this.#queryRaw(`DESCRIBE "${escaped}"`);
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

	/** Clear cached DESCRIBE results. Pass a table name to clear one, or omit for all. */
	clearDescribeCache(table?: string): void {
		if (table) {
			this.#describeCache.delete(table);
		} else {
			this.#describeCache.clear();
		}
	}

	/**
	 * Call after a data reload (e.g. re-running loadParquet/CREATE OR REPLACE
	 * TABLE against an existing table name). Clears everything keyed off the
	 * old data: the query result cache, DESCRIBE cache (schema may have
	 * changed), and materialized preagg cubes (`CREATE TABLE IF NOT EXISTS`
	 * means a stale cube would otherwise keep serving pre-reload aggregates
	 * indefinitely). Registered marks keep their registration — for everything
	 * but identity this only invalidates caches, and callers still need to
	 * trigger a re-query (e.g. a filter change) to see fresh data rendered.
	 *
	 * Identity is the exception, because dropping it invalidates the marks' SQL
	 * rather than just their results. Marks that requested identity columns are
	 * told to re-run setup via onIdentityReset() — see the note there. Await
	 * this promise before assuming the rebuild has started.
	 */
	clearQueryCache(): Promise<void> {
		this.clearDescribeCache();
		// Identity dims are CREATE TABLE IF NOT EXISTS, so a stale dim would keep
		// serving pre-reload ids indefinitely — the same trap as preagg cubes.
		//
		// Dropping them is not enough on its own: a mark's query parts still name
		// __dplot_*_idx columns on a view that no longer exists, and #sourceTable
		// falls back to the base table the moment the view registry is cleared,
		// so the next query would select a column the base table does not have.
		// The listeners are what closes that — they re-run mark setup, which
		// re-requests the columns and rebuilds the dims against the new data.
		//
		// Notified in a `finally` so a failed DROP still invalidates: partially
		// dropped state is no more usable than fully dropped state. An
		// ensureColumns still in flight across this rejects rather than resolving
		// against dropped state (see CategoricalIdentity's generation counter).
		const identityReset = this.#identity.reset().finally(() => this.#notifyIdentityReset());
		this.#preagg.reset();
		this.#queryCache.clear();
		return identityReset;
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
	 * Load Arrow IPC bytes as a named table (DuckDB-WASM only).
	 * Throws if the underlying connection doesn't support it (e.g. REST).
	 */
	async insertArrowFromIPCStream(
		data: Uint8Array,
		options: { name: string; create: boolean }
	): Promise<void> {
		if (!this.#conn) await this.#ensureConnection();
		const conn = this.#conn!;
		if (!conn.insertArrowFromIPCStream) {
			throw new Error('Arrow IPC loading requires a DuckDB-WASM connection');
		}
		await conn.insertArrowFromIPCStream(data, options);
	}

	// -----------------------------------------------------------------
	// v3: Mark registration + batch filter queries
	// -----------------------------------------------------------------

	/**
	 * Register a mark with the engine. Returns a MarkHandle for reading results.
	 *
	 * On first registration: returns a new handle, does NOT fire an initial
	 * query — the mark's params $effect calls handle.updateParams() which
	 * triggers _onParamsChange → #queryMark.
	 *
	 * On re-registration (same markId, e.g. rebin): reuses the existing handle
	 * so arrowTable stays populated during the re-query (no flash-of-empty).
	 * Fires a re-query immediately since the params effect won't trigger
	 * (handle reference is unchanged).
	 */
	registerMark(markId: string, descriptor: QueryDescriptor, filterGroup: FilterGroup): MarkHandle {
		const prev = this.#marks.get(markId);
		if (prev) {
			// Don't cancel inflight queries — let them complete for intermediate
			// visual updates (e.g. smooth rebin steps during shift+scroll).
			// Execute-latest in query() handles supersession naturally.
			this.#preagg.dropMark(markId);
		}

		// Reuse existing handle to preserve arrowTable during re-query
		const handle = prev?.handle ?? new MarkHandle();
		const reg: MarkRegistration = { descriptor, handle, filterGroup };
		this.#marks.set(markId, reg);
		this.#preagg.trackTable(descriptor.baseTable);

		handle._onParamsChange = () => this.#queryMark(markId, reg);

		handle.destroy = () => {
			this.cancel(markId);
			this.#preagg.dropMark(markId);
			this.#marks.delete(markId);
			handle._onParamsChange = null;
		};

		// Re-registration: trigger re-query immediately with updated descriptor.
		// The params effect won't fire since the handle reference didn't change.
		if (prev) {
			this.#queryMark(markId, reg);
		}

		return handle;
	}

	/** When a filter last changed, in any group, for settling (performance.now()). */
	get lastFilterChangeAt(): number {
		return this.#lastFilterChangeAt;
	}

	/**
	 * Called by FilterGroup when any filter clause changes.
	 * Iterates registered marks for this group and batch-queries them.
	 */
	onFilterChange(group: FilterGroup): void {
		this.#lastFilterChangeAt = performance.now();
		const batch: Array<[string, MarkRegistration]> = [];
		for (const [markId, reg] of this.#marks) {
			if (reg.filterGroup === group) {
				batch.push([markId, reg]);
			}
		}
		if (batch.length > 0) {
			this.#executeBatch(batch);
		}
	}

	#executeBatch(batch: Array<[string, MarkRegistration]>): void {
		for (const [markId, reg] of batch) this.#queryMark(markId, reg);
	}

	/**
	 * Query a single mark: on a filter change (via #executeBatch) or a params
	 * change (via _onParamsChange). Reads a preagg table when one answers; if
	 * that read fails, the table is set aside and the base table is queried once.
	 */
	#queryMark(markId: string, reg: MarkRegistration): void {
		const { handle } = reg;
		const preagg = this.#preagg.sqlFor(markId, reg);
		const sqlStr = preagg?.sql || this.#baseSQL(markId, reg);
		if (!sqlStr) return;

		// Use the public query() path — its execute-latest logic ensures
		// at most 1 inflight + 1 pending per callerId during rapid brushing.
		this.query(sqlStr, { callerId: markId })
			.catch((e) => {
				if (!preagg || (e as Error)?.name === 'AbortError') throw e;
				this.#preagg.readFailed(markId, preagg.table, e);
				const baseSQL = this.#baseSQL(markId, reg);
				if (!baseSQL) throw e;
				return this.query(baseSQL, { callerId: markId });
			})
			.then((table) => handle._setResult(table))
			.catch((e) => {
				if ((e as Error)?.name === 'AbortError') return;
				handle._setError(e as Error);
			});
	}

	/** The query a mark runs on its base table, applying every clause. */
	#baseSQL(markId: string, reg: MarkRegistration): string | null {
		const { descriptor, handle } = reg;
		return this.#assembleSQL(
			descriptor,
			descriptor.table,
			reg.filterGroup.selection.predicate(markId),
			handle.params
		);
	}

	/**
	 * Assemble SQL from a query descriptor + filter + per-mark params.
	 * Moves CAST wrapping logic from MarkLifecycleV2.#buildQueryString.
	 */
	#assembleSQL(
		descriptor: QueryDescriptor,
		sourceTable: string,
		filter: unknown[],
		params: QueryParams
	): string | null {
		const { parts, schema, transformCompiler } = descriptor;
		const { selectDef } = parts;

		// Window aggregates (e.g. smooth overlay): DuckDB requires the inner
		// aggregate's columns to be in GROUP BY or inside a regular aggregate,
		// so split into inner GROUP BY + outer window CTE.
		if (parts.hasWindowAggregates) {
			const split = splitWindowSelect(selectDef, parts.passthroughChannels, schema);
			return assembleQuery({
				table: sourceTable,
				parts: {
					...parts,
					selectDef: split.innerSelect,
					nonAggregateGroupBy: split.innerGroupBy,
					hasAggregates: true
				},
				filter,
				transformCompiler,
				limit: params.limit,
				window: { channels: split.windowChannels, cteName: '__window_cte' }
			}).toString();
		}

		// Flat path: CAST-wrap numeric channels so DuckDB returns Float32Array.
		const castSelectDef: Record<string, unknown> = {};
		for (const [ch, expr] of Object.entries(selectDef)) {
			castSelectDef[ch] = castNumeric(expr, schema);
		}

		return assembleQuery({
			table: sourceTable,
			parts: { ...parts, selectDef: castSelectDef },
			filter,
			transformCompiler,
			limit: params.limit
		}).toString();
	}

	/**
	 * Pre-aggregate marks for a filter group before a source is used: builds a
	 * preagg table per mark the source filters (see Preagg.activate). Called
	 * through the source's handle on pointerenter — before the first drag.
	 */
	activate(filterGroup: FilterGroup, source: ActivationSource): Promise<void> {
		return this.#preagg.activate(filterGroup, source);
	}

	/**
	 * Run a hover's activations as one batch: builds still queued from an earlier
	 * batch are dropped (see BuildQueue).
	 */
	batch(activations: () => void): void {
		this.#preagg.batch(activations);
	}

	/**
	 * Forget a source's preagg tables: its last registration is gone. Called by
	 * FilterGroup.
	 */
	forgetSource(filterGroup: FilterGroup, sourceId: string): void {
		this.#preagg.forgetSource(filterGroup, sourceId);
	}

	/**
	 * Destroy the engine and close the connection.
	 */
	async destroy(): Promise<void> {
		// Before the destroyed flag: reset() and the preagg drops go through
		// this.exec(), which throws once destroyed.
		await this.#identity.reset().catch(() => {});
		// Settle activations still waiting on queued builds, drop this session's tables
		await this.#preagg.destroy();
		this.#destroyed = true;
		this.#marks.clear();
		this.#queryCache.clear();
		for (const controller of this.#inflight.values()) {
			controller.abort();
		}
		this.#inflight.clear();
		for (const pending of this.#pending.values()) {
			pending.reject(new DOMException('Engine destroyed', 'AbortError'));
		}
		this.#pending.clear();
		const conn = this.#conn ?? (this.#connPromise ? await this.#connPromise : null);
		if (conn) await conn.close();
	}
}

// ---------------------------------------------------------------------------
// LRU query cache
// ---------------------------------------------------------------------------

const requestIdle = typeof requestIdleCallback !== 'undefined' ? requestIdleCallback : setTimeout;

interface LruCacheOptions {
	max: number;
	ttl: number;
}

interface LruCache<T> {
	get(key: string): T | Promise<T> | undefined;
	set(key: string, value: T | Promise<T>): void;
	delete(key: string): void;
	clear(): void;
}

function lruCache<T>({ max, ttl }: LruCacheOptions): LruCache<T> {
	let entries = new Map<string, { last: number; value: T | Promise<T> }>();

	function evict() {
		const expire = performance.now() - ttl;
		let lruKey: string | null = null;
		let lruLast = Infinity;
		for (const [key, entry] of entries) {
			if (entry.last < lruLast) {
				lruKey = key;
				lruLast = entry.last;
			}
			if (expire > entry.last) {
				entries.delete(key);
			}
		}
		if (lruKey) entries.delete(lruKey);
	}

	return {
		get(key: string) {
			const entry = entries.get(key);
			if (entry) {
				entry.last = performance.now();
				return entry.value;
			}
		},
		set(key: string, value: T | Promise<T>) {
			entries.set(key, { last: performance.now(), value });
			if (entries.size > max) requestIdle(evict);
		},
		delete(key: string) {
			entries.delete(key);
		},
		clear() {
			entries = new Map();
		}
	};
}
