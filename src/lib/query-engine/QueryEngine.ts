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
import {
	isAggregateExpression,
	isNode,
	collectColumns,
	column,
	and,
	isBetween,
	literal,
	Query,
	sql as sqlTag,
	type ExprNode,
	type WindowNode
} from '@uwdata/mosaic-sql';
import { togglePredicate } from './toggle-predicate';
import {
	rewriteForPreagg,
	buildBinExpr,
	binsFineEnough,
	BIN_WINDOW_MARGIN,
	type BrushActivation
} from './sufficient-statistics';
export type { BrushActivation } from './sufficient-statistics';
import {
	assembleQuery,
	castNumeric,
	castReal,
	splitWindowSelect,
	type QueryParts
} from '$lib/components/marks/lifecycle/query-builder';
import { MarkHandle, type QueryParams } from './MarkHandle.svelte';
import {
	CategoricalIdentity,
	type DimValue,
	type FieldIdentity,
	type IdentityField
} from './categorical-identity';
import type { FilterGroup } from './FilterGroup.svelte';
import type { Clause, CrossfilterSelection, FilterExpr } from './CrossfilterSelection.svelte';
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

/** TEMPORARY: flip to false to bypass preagg routing and force base-table queries.
 *  Used for benchmarking preagg vs. base. Revert to true before shipping. */
const PREAGG_ENABLED = true;

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

/**
 * How a source selects, one entry per active dimension: a pixel-binned
 * continuous column (`bin`, with the data extent when known, for the size
 * guard), or a categorical field (`value`, keyed by its identity key).
 */
export type ActiveDim =
	| ({ kind: 'bin'; extent?: [number, number] } & BrushActivation)
	| { kind: 'value'; field: string };

/** What activate() needs to know about a source, as FilterGroup sees it at hover time. */
export interface ActivationSource {
	sourceId: string;
	/** Marks every registration of the source excludes: it filters none of them. */
	excludedByAll: Set<string>;
	dims: ActiveDim[];
	/**
	 * For a source with bin dims: writes its current view, `[d0, d1, pixel
	 * extent]` per bin dim, into `out`. Read on every query, so it must not
	 * allocate.
	 */
	view?: (out: Float64Array) => void;
}

/** What a preagg table was built from. It serves brush queries only while this still holds. */
interface PreaggBasis {
	/** Query parts, compared by reference ($derived memoization keeps them stable). */
	parts: QueryParts;
	/** The source whose clause the table answers instead of baking in. */
	activeSourceId: string;
	/** What the active dims' columns are: bin column, or value field. A bin
	 *  dim's view is checked separately (binsFitView, #binsFineEnough). */
	dimsKey: string;
	/** The clause objects baked into the table, in selection insertion order.
	 *  Refreshed when new objects turn out to give the same SQL. */
	bakedClauses: Clause[];
	/** The source's current view, for the bin resolution check (bin dims only). */
	view: ((out: Float64Array) => void) | null;
}

/** The filter-independent parts of a preagg table's SELECT. */
interface PreaggCreation {
	table: string;
	select: Record<string, ExprNode>;
	groupby: ExprNode[];
	orderby: ExprNode[];
	/**
	 * Fields grouped by value inside and mapped to their ids on the grouped
	 * result: `raw` is the inner column, `alias` the id column, `dim` the dim
	 * table joined on value. Empty for every other table.
	 */
	joins: Array<{ raw: string; alias: string; dim: string }>;
}

/**
 * How each active dim appears in a preagg table. A `bin` dim is a pixel-bin
 * index over a window (`buildBinExpr`): bins 0 .. bins - 1 from d0, with -1
 * and `bins` for everything outside it. A `value` dim is a column holding the
 * field's ids (`byId`) or its raw values, in the source's field order.
 */
type ActiveMeta =
	| { kind: 'bin'; alias: string; d0: number; scaleFactor: number; bins: number }
	| { kind: 'value'; field: string; column: string; byId: boolean };

/**
 * A group key of a planned table, for the size guard: how many groups it has
 * (null: unknown), and the one source column it bins, if it bins exactly one,
 * so a key on a column the mark already groups by is not counted twice.
 */
interface GroupKey {
	column: string | null;
	groups: number | null;
}

interface PreaggState {
	table: string;
	/** The SELECT the table was created from. Its hash names the table. */
	sql: string;
	basis: PreaggBasis;
	creation: PreaggCreation;
	/** Clause objects already found to give different SQL, so frames that
	 *  still see them go to the base table without rebuilding the SQL. */
	mismatch: Clause[] | null;
	/** Rewritten select expressions that recombine partials at query time. */
	outputSelect: Record<string, ExprNode>;
	/** The active dims as the table holds them, for the query-time filter. */
	activeMeta: ActiveMeta[];
	/** Window channels needing CTE wrapping in the preagg query. */
	windowChannels: Record<string, import('@uwdata/mosaic-sql').WindowNode> | null;
}

/** A preagg build waiting in the engine's queue. */
interface QueuedBuild {
	markId: string;
	sourceId: string;
	build: PreaggState;
	createSQL: string;
	/** The hover batch that queued it. */
	batch: number;
	/** When it was queued, for the wait limit (BUILD_MAX_WAIT_MS). */
	queuedAt: number;
	/** Settles the activate() call that queued it. */
	done: () => void;
}

interface MarkRegistration {
	descriptor: QueryDescriptor;
	handle: MarkHandle;
	filterGroup: FilterGroup;
	/**
	 * Built preagg tables, one per activated source. A query reads the first
	 * whose basis holds and moves it to the front, so the next frame of the
	 * same gesture checks it first.
	 */
	preagg: Map<string, PreaggState>;
	/** The latest build started per source. A finished build is installed only
	 *  if it is still this one, so a superseded or dropped build never lands. */
	preaggBuild: Map<string, PreaggState>;
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
	/** Hash-named preagg tables created this session (for cleanup on destroy). */
	#preaggTables = new Set<string>();
	/**
	 * Row count per base table, for the size guard: a number once read, the
	 * read in flight before that. Read once per table when its first mark
	 * registers, outside any interaction.
	 */
	#rowCounts = new Map<string, number | Promise<void>>();
	/**
	 * Preagg builds waiting to run, oldest first. Builds are speculative full
	 * scans on the one connection, which runs statements in arrival order, so
	 * sending them as they are planned would put a click's queries behind all
	 * of them. The engine holds them instead and sends one at a time, only while
	 * no mark query is waiting or running, or once the oldest has waited
	 * BUILD_MAX_WAIT_MS.
	 */
	#buildQueue: QueuedBuild[] = [];
	#buildRunning = false;
	/** Pumps the queue when the oldest build's wait runs out, if no query does first. */
	#waitTimer: ReturnType<typeof setTimeout> | null = null;
	/** The current hover batch. Builds still queued from an older one are dropped. */
	#batch = 0;
	#inBatch = false;
	/** When a filter last changed, in any group (performance.now()). */
	#lastFilterChangeAt = 0;
	/** Scratch for a source's view, reused by every query's resolution check. */
	#viewScratch = new Float64Array(6);
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

	#buildMaxWaitMs: number;

	constructor(
		connection: DuckDBConnection | Promise<DuckDBConnection>,
		options: QueryEngineOptions = {}
	) {
		this.#buildMaxWaitMs = options.buildMaxWaitMs ?? BUILD_MAX_WAIT_MS;
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
			this.#pumpBuilds();
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
		for (const item of this.#buildQueue) this.#abandon(item);
		this.#buildQueue = [];
		for (const reg of this.#marks.values()) {
			this.#dropPreagg(reg);
		}
		for (const preaggTable of this.#preaggTables) {
			this.exec(`DROP TABLE IF EXISTS "${preaggTable}"`).catch(() => {});
		}
		this.#preaggTables.clear();
		this.#rowCounts.clear();
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
			this.#dropPreagg(prev);
		}

		// Reuse existing handle to preserve arrowTable during re-query
		const handle = prev?.handle ?? new MarkHandle();
		const reg: MarkRegistration = {
			descriptor,
			handle,
			filterGroup,
			preagg: new Map(),
			preaggBuild: new Map()
		};
		this.#marks.set(markId, reg);
		this.#countRows(descriptor.baseTable);

		handle._onParamsChange = () => this.#queryMark(markId, reg);

		handle.destroy = () => {
			this.cancel(markId);
			this.#dropPreagg(reg);
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
			this.#executeBatch(batch, group.selection);
		}
	}

	#executeBatch(
		batch: Array<[string, MarkRegistration]>,
		selection: { predicate(markId: string): unknown[] }
	): void {
		for (const [markId, reg] of batch) {
			const { descriptor, handle } = reg;

			const preagg = this.#usablePreagg(markId, reg);
			const sqlStr =
				(preagg && this.#assemblePreaggSQL(markId, reg, preagg, handle.params)) ||
				this.#assembleSQL(descriptor, descriptor.table, selection.predicate(markId), handle.params);
			if (!sqlStr) continue;

			// Use the public query() path — its execute-latest logic ensures
			// at most 1 inflight + 1 pending per callerId during rapid brushing.
			this.query(sqlStr, { callerId: markId })
				.then((table) => handle._setResult(table))
				.catch((e) => {
					if ((e as Error)?.name === 'AbortError') return;
					handle._setError(e as Error);
				});
		}
	}

	/**
	 * Query a single mark (triggered by params change via _onParamsChange).
	 */
	#queryMark(markId: string, reg: MarkRegistration): void {
		const { descriptor, handle } = reg;

		const preagg = this.#usablePreagg(markId, reg);
		const sqlStr =
			(preagg && this.#assemblePreaggSQL(markId, reg, preagg, handle.params)) ||
			this.#assembleSQL(
				descriptor,
				descriptor.table,
				reg.filterGroup.selection.predicate(markId),
				handle.params
			);
		if (!sqlStr) return;

		this.query(sqlStr, { callerId: markId })
			.then((table) => handle._setResult(table))
			.catch((e) => {
				if ((e as Error)?.name === 'AbortError') return;
				handle._setError(e as Error);
			});
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
				filterNulls: params.filterNulls ?? null,
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
			filterNulls: params.filterNulls ?? null,
			transformCompiler,
			limit: params.limit
		}).toString();
	}

	/**
	 * Pre-aggregate marks for a filter group before a source is used.
	 * Called through the source's handle on pointerenter — before the first drag.
	 *
	 * Builds materialized preagg tables for all aggregate marks in the filter
	 * group that the source filters, one per source, next to any the mark holds
	 * for other sources. Each table bakes in every clause except the source's
	 * own and groups by the source's active dims as well as the mark's own, so
	 * a change to the source is a filter on a table of thousands of rows: pixel
	 * bins for a brush, the field's ids (or values) for a toggle or legend.
	 *
	 * The source is named by its ID rather than inferred: before the first drag
	 * it has no clause yet, and other clauses on the same chart (a Toggle)
	 * exclude the same marks a brush does.
	 */
	async activate(filterGroup: FilterGroup, source: ActivationSource): Promise<void> {
		const { sourceId: activeSourceId, excludedByAll, dims } = source;
		if (this.#destroyed || dims.length === 0) return;
		// An activation outside batch() (a legend's hover) is a batch of one.
		if (!this.#inBatch) this.#startBatch();

		const { selection } = filterGroup;
		const dimsKey = activeDimsKeyOf(dims);
		const promises: Promise<void>[] = [];

		for (const [markId, reg] of this.#marks) {
			if (reg.filterGroup !== filterGroup) continue;
			// A mark the source never filters gets no table for it, and keeps
			// the tables it holds for other sources.
			if (excludedByAll.has(markId)) continue;

			// Skip if the latest build, finished or in flight, still matches
			const latest = reg.preaggBuild.get(activeSourceId) ?? reg.preagg.get(activeSourceId);
			if (latest) {
				const { basis } = latest;
				if (
					basis.parts === reg.descriptor.parts &&
					basis.activeSourceId === activeSourceId &&
					basis.dimsKey === dimsKey &&
					binsFitView(latest.activeMeta, dims) &&
					this.#bakedClausesHold(markId, selection, latest)
				) {
					continue;
				}
			}

			// Drop this source's stale table; other sources' stay.
			reg.preagg.delete(activeSourceId);
			reg.preaggBuild.delete(activeSourceId);

			const plan = this.#planPreagg(reg, dims);
			if (!plan) continue;
			if (this.#tooLarge(reg, plan.activeKeys)) continue;

			// Bake every other clause into the preagg table. Sorted by source ID,
			// so the same filters always give the same SQL, and so the same table.
			const bakedClauses = selection.bakedClauses(markId, activeSourceId);
			const staticFilters = selection.bakedPredicates(markId, activeSourceId);

			// Hash-based naming: identical preagg SQL reuses the same table (like Mosaic).
			// CREATE TABLE IF NOT EXISTS avoids rebuilding when switching charts.
			const preaggSQL = preaggSelectSQL(plan.creation, staticFilters);
			const preaggTable = `__dplot_preagg_${fnvHash(preaggSQL).toString(16)}`;
			const createSQL = `CREATE TABLE IF NOT EXISTS "${preaggTable}" AS ${preaggSQL}`;

			// The basis is captured now, not when the build finishes: a filter
			// that changes while the CREATE runs must still read as a mismatch.
			const build: PreaggState = {
				table: preaggTable,
				sql: preaggSQL,
				basis: {
					parts: reg.descriptor.parts,
					activeSourceId,
					dimsKey,
					bakedClauses,
					view: source.view ?? null
				},
				creation: plan.creation,
				mismatch: null,
				outputSelect: plan.outputSelect,
				activeMeta: plan.activeMeta,
				windowChannels: plan.windowChannels
			};
			reg.preaggBuild.set(activeSourceId, build);

			this.#preaggTables.add(preaggTable);
			const batch = this.#batch;
			promises.push(
				new Promise<void>((done) => {
					this.#buildQueue.push({
						markId,
						sourceId: activeSourceId,
						build,
						createSQL,
						batch,
						queuedAt: performance.now(),
						done
					});
				})
			);
		}

		this.#pumpBuilds();
		await Promise.all(promises);
	}

	/**
	 * Run a hover's activations as one batch: builds still queued from an earlier
	 * batch are dropped. One chart hover activates several sources (a brush, a
	 * Toggle field, a band-label field), so the batch, not the source, is what a
	 * newer hover supersedes. Its sources can belong to different filter groups,
	 * which is why the batch lives here.
	 */
	batch(activations: () => void): void {
		if (this.#inBatch) {
			activations();
			return;
		}
		this.#startBatch();
		this.#inBatch = true;
		try {
			activations();
		} finally {
			this.#inBatch = false;
		}
	}

	#startBatch(): void {
		this.#batch++;
		const keep: QueuedBuild[] = [];
		for (const item of this.#buildQueue) {
			if (item.batch === this.#batch) keep.push(item);
			else this.#abandon(item);
		}
		this.#buildQueue = keep;
	}

	/** Drop a queued build, so the next activation plans it again. */
	#abandon(item: QueuedBuild): void {
		const reg = this.#marks.get(item.markId);
		if (reg?.preaggBuild.get(item.sourceId) === item.build) reg.preaggBuild.delete(item.sourceId);
		item.done();
	}

	/**
	 * Send the next queued build if nothing else is on the connection: no build
	 * running, and no mark query waiting or running. Called when a build is
	 * queued, when one finishes, and when a mark query settles. Queries without
	 * a caller id (identity lookups, describe, ad-hoc queries) do not hold builds
	 * back and can wait behind a running one; none is on an interaction path.
	 *
	 * Mark queries hold a build back for at most BUILD_MAX_WAIT_MS. A drag that
	 * starts before its source's tables are built reads the base table, each
	 * read slower than a frame, so a query is always waiting and the build would
	 * never run; past the limit it is sent anyway, and one frame waits for it.
	 */
	#pumpBuilds(): void {
		while (!this.#buildRunning && !this.#destroyed) {
			const head = this.#buildQueue[0];
			if (!head) return;
			if (this.#inflight.size > 0 || this.#pending.size > 0) {
				const waited = performance.now() - head.queuedAt;
				if (waited < this.#buildMaxWaitMs) {
					this.#waitTimer ??= setTimeout(() => {
						this.#waitTimer = null;
						this.#pumpBuilds();
					}, this.#buildMaxWaitMs - waited);
					return;
				}
			}
			const item = this.#buildQueue.shift()!;
			const { markId, sourceId, build } = item;

			// Checked against the mark's current registration, which a re-setup
			// replaces, against the view now (a zoom in or a long pan while it
			// waited means a table settling would only rebuild), and against the
			// filters now: a clause baked into the table may have changed.
			const reg = this.#marks.get(markId);
			if (
				!reg ||
				reg.preaggBuild.get(sourceId) !== build ||
				reg.descriptor.parts !== build.basis.parts ||
				!this.#binsFitCurrentView(build) ||
				!this.#bakedClausesHold(markId, reg.filterGroup.selection, build)
			) {
				this.#abandon(item);
				continue;
			}

			this.#buildRunning = true;
			this.exec(item.createSQL)
				.then(() => {
					const current = this.#marks.get(markId);
					if (current?.preaggBuild.get(sourceId) !== build) return;
					current.preaggBuild.delete(sourceId);
					current.preagg.set(sourceId, build);
				})
				.catch((e) => {
					console.warn(`[QueryEngine] preagg failed for ${markId}:`, e);
					const current = this.#marks.get(markId);
					if (current?.preaggBuild.get(sourceId) === build) current.preaggBuild.delete(sourceId);
				})
				.finally(() => {
					this.#buildRunning = false;
					item.done();
					this.#pumpBuilds();
				});
			return;
		}
	}

	/**
	 * The preagg table a mark would build for a source's active dims, or null
	 * when the mark cannot be pre-aggregated (no aggregates, or an aggregate that
	 * does not decompose).
	 *
	 * A `value` dim's column is resolved per mark:
	 * 1. The mark already groups by the field's id (a channel reading only its
	 *    id column): nothing is added; the filter goes on that channel.
	 * 2. The field's dim covers the mark's base table, so every non-NULL value
	 *    has an id: the field is grouped by value inside and mapped to its ids
	 *    on the grouped result, a join over thousands of rows rather than the
	 *    view's join over every row. A view that already exposes the id column
	 *    is grouped by it directly.
	 * 3. Otherwise the field's values themselves, filtered with the toggle's own
	 *    predicate over that column.
	 *
	 * Also returns the active dims' group keys, for the size guard.
	 */
	#planPreagg(
		reg: MarkRegistration,
		dims: ActiveDim[]
	): {
		creation: PreaggCreation;
		outputSelect: Record<string, ExprNode>;
		activeMeta: ActiveMeta[];
		windowChannels: Record<string, WindowNode> | null;
		activeKeys: GroupKey[];
	} | null {
		const { parts, table, baseTable, schema } = reg.descriptor;
		if (!parts.hasAggregates && !parts.hasWindowAggregates) return null;

		// Analyze selectDef for preagg compatibility
		const analysis = rewriteForPreagg(parts.selectDef, parts.passthroughChannels);
		if (!analysis) return null; // unsupported (window/distinct)
		const { preaggCols, outputSelect, preaggGroupBy } = analysis;

		const activeMeta: ActiveMeta[] = [];
		const activeGroupBy: ExprNode[] = [];
		const binOrder: ExprNode[] = [];
		const joins: PreaggCreation['joins'] = [];
		const activeKeys: GroupKey[] = [];

		dims.forEach((dim, i) => {
			const alias = `__active${i}`;
			if (dim.kind === 'bin') {
				const { expr, d0, scaleFactor, bins } = buildBinExpr(
					dim.columnRef,
					dim.domain,
					dim.pixelExtent
				);
				preaggCols[alias] = expr;
				activeGroupBy.push(column(alias));
				binOrder.push(column(alias));
				activeMeta.push({ kind: 'bin', alias, d0, scaleFactor, bins });
				// The window's bins plus the two edge bins, or fewer when the data
				// spans less than the window at this resolution.
				const dataBins = dim.extent
					? Math.ceil((dim.extent[1] - dim.extent[0]) * scaleFactor) + 1
					: Infinity;
				const binned = collectColumns(dim.columnRef);
				activeKeys.push({
					column: binned.length === 1 ? binned[0].column : null,
					groups: Math.min(bins + 2, dataBins)
				});
				return;
			}

			const { field } = dim;
			const channel = this.#idChannelFor(parts.selectDef, field);
			if (channel) {
				// Case 1: already a group key of the mark.
				activeMeta.push({ kind: 'value', field, column: channel, byId: true });
				return;
			}
			// One more group for -1: NULL, or a value the dim does not hold.
			const idGroups = this.#identity.values(field).length + 1;
			if (this.#identity.dimCovers(field, baseTable)) {
				// Case 2.
				if (table !== baseTable && this.#identity.viewHas(baseTable, field)) {
					preaggCols[alias] = column(this.#identity.idColumn(field));
					activeGroupBy.push(column(alias));
				} else {
					const raw = `__raw${i}`;
					preaggCols[raw] = fieldExpr(this.#identity.sqlFor(field), field);
					activeGroupBy.push(column(raw));
					joins.push({ raw, alias, dim: this.#identity.dimTable(field) });
				}
				activeMeta.push({ kind: 'value', field, column: alias, byId: true });
				activeKeys.push({ column: null, groups: idGroups });
				return;
			}
			// Case 3.
			preaggCols[alias] = fieldExpr(this.#identity.sqlFor(field), field);
			activeGroupBy.push(column(alias));
			activeMeta.push({ kind: 'value', field, column: alias, byId: false });
			activeKeys.push({ column: null, groups: null });
		});

		// CAST-wrap dimension preaggCols (bake CAST into the preagg table).
		// Partial-aggregate and active columns stay raw for recombination.
		for (const [ch, expr] of Object.entries(preaggCols)) {
			if (ch.startsWith('__ps') || ch.startsWith('__active') || ch.startsWith('__raw')) continue;
			if (isAggregateExpression(expr)) continue;
			preaggCols[ch] = castNumeric(expr, schema) as ExprNode;
		}

		return {
			creation: {
				table,
				select: preaggCols as Record<string, ExprNode>,
				groupby: [...preaggGroupBy, ...activeGroupBy] as ExprNode[],
				// Sorted by bin columns for fast range scans
				orderby: binOrder,
				joins
			},
			outputSelect,
			activeMeta,
			windowChannels: analysis.windowChannels,
			activeKeys
		};
	}

	/** The mark's channel that is `field`'s id channel (see #idFieldOf), or null. */
	#idChannelFor(selectDef: Record<string, unknown>, field: string): string | null {
		for (const [channel, expr] of Object.entries(selectDef)) {
			if (this.#idFieldOf(expr) === field) return channel;
		}
		return null;
	}

	/**
	 * The field whose ids a channel holds, or null. Only the id column itself or
	 * castReal of it, the forms marks produce: an id filter on any other
	 * expression over the column (say idx % 2) would filter transformed values.
	 * Compared as SQL text; runs when a table is planned, not per query.
	 */
	#idFieldOf(expr: unknown): string | null {
		if (!isNode(expr) || isAggregateExpression(expr as ExprNode)) return null;
		const read = collectColumns(expr as ExprNode);
		if (read.length !== 1) return null;
		const field = this.#identity.fieldOfIdColumn(read[0].column);
		if (field == null) return null;
		const text = String(expr);
		const idColumn = column(read[0].column);
		return text === String(idColumn) || text === String(castReal(idColumn)) ? field : null;
	}

	/**
	 * The size guard: whether a planned table would hold more than a quarter of
	 * its base table's rows (a fixed 100,000 until the row count has been read).
	 *
	 * Measured on 1M rows (DuckDB-WASM, one thread): a toggle click on a table a
	 * quarter the size of the base table is still ~3.7× faster than on the base
	 * table, and its build costs ~2.5 base queries; at 43% the click is 2.1×
	 * faster and the build ~3.5 base queries; at 69%, 1.4× and ~4. Builds run
	 * when the connection is idle, so their cost shows only as the wait of a
	 * click that lands mid-build, and as memory; past a quarter that outweighs
	 * the gain.
	 *
	 * Counts the table's groups, which are the mark's groups before its SQL
	 * transforms and before the active source's filter, combined with the
	 * active dims' (#markKeys). Keys multiply, except that a field or column is
	 * counted once: a mark with x and fill on the same field has that field's
	 * groups, not their square, and a bin dim on a column the mark already
	 * groups by adds its bins to that key's (each pixel bin falls in about one
	 * of the mark's bins) instead of multiplying. Only an active dim without a
	 * known cardinality (a field with no dim) leaves the estimate unknown, and an
	 * unknown estimate builds.
	 */
	#tooLarge(reg: MarkRegistration, activeKeys: GroupKey[]): boolean {
		if (activeKeys.some((key) => key.groups == null)) return false;
		const merged = new Set<GroupKey>();
		let groups = 1;
		for (const key of this.#markKeys(reg)) {
			const same =
				key.column == null
					? undefined
					: activeKeys.find((active) => active.column === key.column && !merged.has(active));
			if (same) merged.add(same);
			groups *= key.groups! + (same?.groups ?? 0);
		}
		for (const key of activeKeys) if (!merged.has(key)) groups *= key.groups!;
		const rows = this.#rowCounts.get(reg.descriptor.baseTable);
		const cap = typeof rows === 'number' ? rows / 4 : 100_000;
		return groups > cap;
	}

	/**
	 * The mark's own group keys. When every one is a categorical field's id
	 * channel, one key per distinct field, sized by its dim. Otherwise one key
	 * for the whole mark, sized by its last result's row count (a lower bound:
	 * filters or a transform may cut it, and a topN mark groups by an id channel
	 * and is counted exactly above), or one group under a limit or before a
	 * result; it names the column the mark groups by when there is only one.
	 */
	#markKeys(reg: MarkRegistration): GroupKey[] {
		const { parts } = reg.descriptor;
		const fields = new Set<string>();
		const columns = new Set<string>();
		let allIds = true;
		for (const expr of Object.values(parts.selectDef)) {
			if (!isNode(expr) || isAggregateExpression(expr as ExprNode)) continue;
			for (const { column: name } of collectColumns(expr as ExprNode)) columns.add(name);
			const field = this.#idFieldOf(expr);
			if (field == null) allIds = false;
			else fields.add(field);
		}
		if (allIds) {
			return [...fields].map((field) => ({
				column: null,
				groups: this.#identity.values(field).length + 1
			}));
		}
		const { handle } = reg;
		const rows = handle.params.limit == null ? handle.arrowTable?.numRows : undefined;
		return [{ column: columns.size === 1 ? [...columns][0] : null, groups: rows ?? 1 }];
	}

	/** Read a base table's row count once, for the size guard. */
	#countRows(table: string): void {
		if (this.#rowCounts.has(table)) return;
		const escaped = table.replace(/"/g, '""');
		this.#rowCounts.set(
			table,
			this.query(`SELECT count(*)::DOUBLE AS n FROM "${escaped}"`, { cache: false })
				.then((result) => {
					const n = Number((result.get(0) as { n?: unknown } | null)?.n);
					if (Number.isFinite(n)) this.#rowCounts.set(table, n);
					else this.#rowCounts.delete(table);
				})
				.catch(() => {
					// Unknown: the guard keeps its fixed cap, and a later registration retries.
					this.#rowCounts.delete(table);
				})
		);
	}

	/**
	 * The preagg table a mark's query can read: the first whose query parts
	 * match and whose baked clauses are still in force, or null for the base
	 * table, which applies every clause.
	 *
	 * The table that answers moves to the front. One hover activates several
	 * sources, so the table for the source being dragged need not come first;
	 * a table ahead of it bakes that source's moving clause and fails, possibly
	 * through the SQL comparison in #bakedClausesHold. Moving the answering
	 * table to the front limits that to the first frame of a gesture. When no
	 * table answers, the frame queries the base table, which costs far more.
	 */
	#usablePreagg(markId: string, reg: MarkRegistration): PreaggState | null {
		if (!PREAGG_ENABLED || reg.preagg.size === 0) return null;
		const { selection } = reg.filterGroup;
		let first = true;
		for (const [sourceId, state] of reg.preagg) {
			if (
				state.basis.parts === reg.descriptor.parts &&
				this.#binsFineEnough(state) &&
				this.#bakedClausesHold(markId, selection, state)
			) {
				// A Map keeps the first insertion position of a key, so listing
				// this entry first and spreading the rest moves it to the front.
				if (!first) reg.preagg = new Map([[sourceId, state], ...reg.preagg]);
				return state;
			}
			first = false;
		}
		return null;
	}

	/**
	 * Whether a table's pixel bins are still at least as fine as the current
	 * view's pixels. Bin indexes are floor((v - d0) * scale) with the stored d0
	 * and scale, and the brush filter uses the same pair, so a brush inside the
	 * table's window is answered at any view; only precision depends on bin
	 * width. A pan keeps the width (off by at most one bin edge, one pixel) and
	 * a zoom out makes the bins finer than the pixels, so both keep the table.
	 * Only a zoom in or a larger chart past the built resolution fails here; a
	 * brush past the window is caught where the filter is built. Reads the view
	 * into a reused array: no allocation.
	 */
	#binsFineEnough(state: PreaggState): boolean {
		const { view } = state.basis;
		if (!view) return true;
		const out = this.#viewScratch;
		out.fill(NaN);
		view(out);
		let bin = 0;
		for (const meta of state.activeMeta) {
			if (meta.kind !== 'bin') continue;
			const d0 = out[bin * 3];
			const d1 = out[bin * 3 + 1];
			const extent = out[bin * 3 + 2];
			bin++;
			if (!binsFineEnough(meta.scaleFactor, d1 - d0, extent)) return false;
		}
		return true;
	}

	/**
	 * Whether a queued bin build still suits its source's view, read through the
	 * source's view callback (binFitsView). An unknown view keeps it.
	 */
	#binsFitCurrentView(state: PreaggState): boolean {
		const { view } = state.basis;
		if (!view) return true;
		const out = this.#viewScratch;
		out.fill(NaN);
		view(out);
		let bin = 0;
		for (const meta of state.activeMeta) {
			if (meta.kind !== 'bin') continue;
			const i = 3 * bin++;
			if (!binFitsView(meta, out[i], out[i + 1], out[i + 2])) return false;
		}
		return true;
	}

	/**
	 * Whether the clauses baked into a preagg table are still the ones in force.
	 * Runs on every brush frame. Clause references are compared first, without
	 * allocating. A changed reference may still mean the same filter (a Toggle
	 * re-synced with the same values, a clause removed and re-added), so on a
	 * mismatch the table's SQL is rebuilt from the current clauses and compared.
	 * Once that fails, frames that still see the same clauses skip the rebuild.
	 */
	#bakedClausesHold(markId: string, selection: CrossfilterSelection, state: PreaggState): boolean {
		const { basis } = state;
		const { activeSourceId } = basis;
		if (selection.bakedClausesMatch(markId, activeSourceId, basis.bakedClauses)) return true;
		if (state.mismatch && selection.bakedClausesMatch(markId, activeSourceId, state.mismatch)) {
			return false;
		}

		const current = selection.bakedClauses(markId, activeSourceId);
		const sql = preaggSelectSQL(state.creation, selection.bakedPredicates(markId, activeSourceId));
		if (sql === state.sql) {
			basis.bakedClauses = current;
			state.mismatch = null;
			return true;
		}
		state.mismatch = current;
		return false;
	}

	/**
	 * Assemble SQL for a preagg brush query.
	 * Builds modified QueryParts from the stored outputSelect + bin filters,
	 * then delegates to assembleQuery().
	 */
	#assemblePreaggSQL(
		markId: string,
		reg: MarkRegistration,
		preagg: PreaggState,
		params: QueryParams
	): string | null {
		const { activeMeta, outputSelect, windowChannels } = preagg;

		const { descriptor } = reg;
		const { parts, transformCompiler } = descriptor;

		// --- The active source's clause as a filter on the active columns. None
		// when it has no clause (an empty toggle: every category) or excludes
		// this mark.
		const filters: ExprNode[] = [];
		const clause = reg.filterGroup.selection.get(preagg.basis.activeSourceId);
		if (clause && !clause.excludeMarkIds.has(markId)) {
			// A drag frame runs this per mark: nothing below allocates for a brush
			// beyond its filter, so the value arrays are created only when needed.
			let binCount = 0;
			for (const meta of activeMeta) if (meta.kind === 'bin') binCount++;
			let bin = 0;
			let valueExprs: ExprNode[] | null = null;
			let valueMeta: Array<{ field: string; byId: boolean }> | null = null;
			for (const meta of activeMeta) {
				if (meta.kind === 'value') {
					(valueExprs ??= []).push(column(meta.column));
					(valueMeta ??= []).push(meta);
					continue;
				}
				// Interval1D: value = [lo, hi]; Interval2D: [[xLo, xHi], [yLo, yHi]]
				const range = (binCount === 1 ? clause.value : (clause.value as unknown[])[bin]) as [
					number,
					number
				];
				bin++;
				const binLo = Math.floor((range[0] - meta.d0) * meta.scaleFactor);
				const binHi = Math.floor((range[1] - meta.d0) * meta.scaleFactor);
				// A brush end past the table's window falls in an edge bin, which
				// holds everything beyond it: not answerable here, so the base table.
				if (!(binLo >= 0 && binHi < meta.bins)) return null;
				filters.push(isBetween(column(meta.alias), [literal(binLo), literal(binHi)]) as ExprNode);
			}
			if (valueExprs && valueMeta) {
				// A toggle's clause holds tuples in its field order. Id columns
				// filter by id; a value with no id (NULL, or not in the dim) cannot
				// be expressed, so this query goes to the base table instead.
				const tuples: unknown[][] = [];
				for (const tuple of clause.value as unknown[][]) {
					const mapped: unknown[] = [];
					for (let i = 0; i < valueMeta.length; i++) {
						const { field, byId } = valueMeta[i];
						const v = byId
							? this.#identity.identity(field).ids.get(tuple[i] as DimValue)
							: tuple[i];
						if (v === undefined) return null;
						mapped.push(v);
					}
					tuples.push(mapped);
				}
				filters.push(togglePredicate(valueExprs, tuples));
			}
		}

		// --- Build selectDef: CAST recombined aggregates; dimensions are already
		// CAST in the preagg table; windowed channels are CAST by the outer CTE.
		const castSelect: Record<string, unknown> = {};
		const preaggGroupBy: ExprNode[] = [];
		const preaggGroupKeys: string[] = [];
		for (const [ch, expr] of Object.entries(outputSelect)) {
			if (!isAggregateExpression(expr)) {
				castSelect[ch] = expr;
				preaggGroupBy.push(column(ch));
				preaggGroupKeys.push(ch);
			} else if (windowChannels && ch in windowChannels) {
				castSelect[ch] = expr;
			} else {
				castSelect[ch] = castReal(expr);
			}
		}

		const preaggParts: QueryParts = {
			selectDef: castSelect,
			nonAggregateGroupBy: preaggGroupBy,
			hasAggregates: true,
			groupKeys: preaggGroupKeys,
			hasWindowAggregates: false,
			hasSQLTransforms: parts.hasSQLTransforms,
			orderChannels: parts.orderChannels,
			aliasMap: parts.aliasMap,
			passthroughChannels: parts.passthroughChannels
		};

		return assembleQuery({
			table: preagg.table,
			parts: preaggParts,
			filter: filters,
			filterNulls: null, // preagg table already filtered
			transformCompiler,
			limit: params.limit,
			window: windowChannels ? { channels: windowChannels, cteName: '__preagg_cte' } : null
		}).toString();
	}

	/**
	 * Forget a source's tables on every mark of its group: its last registration
	 * is gone, so nothing can use them. Called by FilterGroup. Does NOT drop the
	 * tables; hash-named tables are reused via CREATE TABLE IF NOT EXISTS.
	 */
	forgetSource(filterGroup: FilterGroup, sourceId: string): void {
		for (const reg of this.#marks.values()) {
			if (reg.filterGroup !== filterGroup) continue;
			reg.preagg.delete(sourceId);
			reg.preaggBuild.delete(sourceId);
		}
	}

	/** Clear preagg state for a registration, including builds in flight.
	 *  Does NOT drop the tables — hash-named tables are reused via CREATE TABLE IF NOT EXISTS. */
	#dropPreagg(reg: MarkRegistration): void {
		reg.preagg.clear();
		reg.preaggBuild.clear();
	}

	/**
	 * Destroy the engine and close the connection.
	 */
	async destroy(): Promise<void> {
		// Before the destroyed flag: reset() goes through this.exec(), which
		// throws once destroyed.
		await this.#identity.reset().catch(() => {});
		this.#destroyed = true;
		if (this.#waitTimer) clearTimeout(this.#waitTimer);
		this.#waitTimer = null;
		// Settle activations still waiting on queued builds
		for (const item of this.#buildQueue) item.done();
		this.#buildQueue = [];
		// Clean up mark registrations
		for (const reg of this.#marks.values()) {
			this.#dropPreagg(reg);
		}
		this.#marks.clear();
		// Drop all preagg tables created this session
		for (const table of this.#preaggTables) {
			this.exec(`DROP TABLE IF EXISTS "${table}"`).catch(() => {});
		}
		this.#preaggTables.clear();
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

/** A preagg table's SELECT. Build and validity check share it, so equal SQL means an equal table. */
function preaggSelectSQL(creation: PreaggCreation, filters: FilterExpr[]): string {
	const query = Query.from(creation.table).select(creation.select).groupby(creation.groupby);
	if (filters.length > 0) query.where(and(filters as ExprNode[]));
	if (creation.joins.length === 0) return query.orderby(creation.orderby).toString();

	// Map fields grouped by value to their ids on the grouped result: a join
	// over the table's groups, not over every source row. The filters stay in
	// the inner query, where the source's columns are in scope.
	const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
	const raws = creation.joins.map((j) => quote(j.raw)).join(', ');
	const ids = creation.joins
		.map((j, k) => `COALESCE(d${k}.id, -1) AS ${quote(j.alias)}`)
		.join(', ');
	const joins = creation.joins
		.map((j, k) => `LEFT JOIN ${quote(j.dim)} AS d${k} ON p.${quote(j.raw)} = d${k}.value`)
		.join(' ');
	const order = creation.orderby.length ? ` ORDER BY ${creation.orderby.join(', ')}` : '';
	return `SELECT p.* EXCLUDE (${raws}), ${ids} FROM (${query}) AS p ${joins}${order}`;
}

/**
 * What the active dims' columns are: bin column, or value field. A bin dim's
 * domain and pixel extent are left out: a table built at another view still
 * answers it while it fits that view (binsFitView).
 */
function activeDimsKeyOf(dims: ActiveDim[]): string {
	return dims.map((d) => (d.kind === 'bin' ? `bin|${d.columnRef}` : `value|${d.field}`)).join(';');
}

/**
 * Whether a table's bins still suit `dims`' view, so activating keeps it:
 * fine enough for its pixels (the query-time rule), and the view still well
 * inside the binned window, at least half a margin from either edge. A small
 * pan or zoom out keeps the table; a pan of more than half a viewport, a zoom
 * out past the window, or a zoom in past the built resolution rebuilds it
 * around the new view, so the brushes drawn there stay inside the window.
 */
function binsFitView(activeMeta: ActiveMeta[], dims: ActiveDim[]): boolean {
	let next = 0;
	for (const dim of dims) {
		if (dim.kind !== 'bin') continue;
		while (next < activeMeta.length && activeMeta[next].kind !== 'bin') next++;
		const meta = activeMeta[next++];
		if (!meta || meta.kind !== 'bin') return false;
		if (!binFitsView(meta, dim.domain[0], dim.domain[1], dim.pixelExtent)) return false;
	}
	return true;
}

/**
 * Whether one bin dim of a table suits a view of [v0, v1] over `pixelExtent`:
 * its bins are fine enough for the pixels, and the view sits at least half a
 * margin inside the binned window. Unknown numbers (NaN) pass.
 */
function binFitsView(
	meta: Extract<ActiveMeta, { kind: 'bin' }>,
	v0: number,
	v1: number,
	pixelExtent: number
): boolean {
	if (!binsFineEnough(meta.scaleFactor, v1 - v0, pixelExtent)) return false;
	// The window is the built view plus BIN_WINDOW_MARGIN views each side.
	const width = meta.bins / meta.scaleFactor;
	const inset = ((width / (1 + 2 * BIN_WINDOW_MARGIN)) * BIN_WINDOW_MARGIN) / 2;
	return !(v0 < meta.d0 + inset || v1 > meta.d0 + width - inset);
}

/** A field as SQL: the text its identity records, or the column of that name. */
function fieldExpr(sqlText: string | undefined, field: string): ExprNode {
	return sqlText
		? (sqlTag([sqlText] as unknown as TemplateStringsArray) as ExprNode)
		: column(field);
}

/** FNV-1a hash (same algorithm as Mosaic). */
function fnvHash(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
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
