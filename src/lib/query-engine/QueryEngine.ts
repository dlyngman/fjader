/**
 * QueryEngine v1-v3 — DuckDB-WASM wrapper with cancel-on-supersede and
 * mark registration for batch filter-driven re-queries.
 *
 * The mark layer's only interface to DuckDB. All query execution goes through
 * queryEngine.query(sql, opts) for ad-hoc queries, or registerMark() for the
 * reactive registration path: FilterGroup calls onClauseChange() when one
 * clause changes, and onFilterChange() when all of a group's do (clearAll).
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
import { MarkHandle, type QueryParams, type ResultCause } from './MarkHandle.svelte';
import { LaneSlot, type LaneHold, type LaneResult, type SlicedLane } from './sliced-lane';
import { SourceRouting, sourceDDL } from './source-routing';
import {
	CategoricalIdentity,
	type DimValue,
	type FieldIdentity,
	type IdentityField,
	type SyntheticId
} from './categorical-identity';
import type { FilterGroup } from './FilterGroup.svelte';
import { NO_ROUTE, type Clause, type MarkRoute } from './CrossfilterSelection.svelte';
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
	/**
	 * Result caching, and sharing an identical query already running.
	 *
	 * - Mark queries (with a `callerId`): on by default; `false` for queries
	 *   against tables whose contents change without the SQL changing.
	 * - Ad-hoc queries (no `callerId`): off unless `true`, so an app re-reading
	 *   a table it writes to sees its writes. fjader's own setup queries pass
	 *   `true`: they read base tables, which change only on a data reload, after
	 *   which `clearQueryCache()` is the contract.
	 *
	 * The key includes the dims' version (see #cacheKey).
	 */
	cache?: boolean;
	/**
	 * Who is waiting for it; see StatementClass. Default 'interaction'.
	 *
	 * `'background'` runs on another connection when the engine has one (a
	 * sliced lane on DuckDB-WASM), so a TEMP table created with `exec` on the
	 * main connection is invisible there and the query fails: pass
	 * `connectionLocal: true` for statements on connection-local state.
	 */
	class?: StatementClass;
	/** Reads or writes connection-local state; see StatementPlacement. */
	connectionLocal?: boolean;
	/**
	 * The table this read reads (base table, view or preagg table). An
	 * interaction read with one is routed by its source's cost (see
	 * SourceRouting): known-fast on the main connection, unknown or slow sliced
	 * on that source's lane. Without one it stays on the main connection.
	 */
	source?: string;
	/** A mark's data read: its cost updates the source's record. */
	data?: boolean;
	/**
	 * This read is known to be slow (a heavy query on whatever table, as a
	 * mark with `holdsEntrance={false}` says). The engine reads it where a
	 * slow read cannot hold up others (on DuckDB-WASM, sliced on its source's
	 * lane) and does not learn the source's cost from it: the source's other
	 * reads may be quick. A backend with one connection can ignore it.
	 */
	slow?: boolean;
}

/**
 * Where a statement may run, beside who waits for it.
 *
 * `connectionLocal`: it reads or writes state that belongs to one connection
 * (a TEMP table, a session setting), so it stays on the main connection
 * whatever its class. fjader's tooltip tables are TEMP: their writes, drops,
 * hover lookups and the fits that read them pass it. Each table is written
 * through one connection only, so statements on it keep their order. A
 * backend with one connection, or truly shared state, can ignore it.
 */
export interface StatementPlacement {
	class: StatementClass;
	connectionLocal?: boolean;
	/** See QueryOpts.source. */
	source?: string;
	/** See QueryOpts.data. */
	data?: boolean;
	/**
	 * When the read was asked for (query() called): for a mark's
	 * execute-latest read, the state it reflects. Recorded, for data age.
	 */
	requestedAt?: number;
	/** The caller (a mark's id), for the log. */
	callerId?: string;
	/** See QueryOpts.slow. */
	slow?: boolean;
}

/**
 * Who is waiting for a statement. Callers state a class, never a connection:
 * which connection (or later, which backend) serves it is the engine's
 * business, decided in one place, `#send`.
 *
 * - `'interaction'`: someone is looking at the result or about to: mark data,
 *   hover lookups, a mark's setup (domains, dims). The default.
 * - `'background'`: nobody waits for it directly: preagg builds, tooltip-table
 *   writes, cleanup. On DuckDB-WASM it runs on a sliced lane (another
 *   connection, see SlicedLane) unless `connectionLocal`, so a slow build no
 *   longer holds up interaction. Without a lane, preagg builds yield to
 *   interaction statements, not to each other's background work.
 */
export type StatementClass = 'interaction' | 'background';

/** One statement as it reached the connection, for `observeStatements`. */
export interface StatementRecord {
	sql: string;
	/** How it was sent: a query returning rows, a statement, a DESCRIBE, an Arrow insert. */
	kind: 'query' | 'exec' | 'describe' | 'insert';
	class: StatementClass;
	/** Which connection ran it: the main one, or a sliced lane. */
	connection: 'main' | 'lane';
	/** The source it was routed by, when it named one. */
	source?: string;
	/**
	 * When the read was asked for (StatementPlacement.requestedAt). With
	 * `end`, how old the state a result reflects is when it lands.
	 */
	requested?: number;
	/** Who asked (a mark's id), when it said. */
	caller?: string;
	/** performance.now() when handed to the connection, and when it settled. */
	start: number;
	end: number;
	error?: unknown;
}

/**
 * How long a queued build waits behind mark queries before it is sent anyway,
 * by default. During a drag on the base table a mark query is always waiting
 * (each one takes longer than a frame), so without a limit the build that
 * would make the drag fast never runs. Past it, one frame waits behind the
 * build instead.
 */
const BUILD_MAX_WAIT_MS = 100;

/**
 * Sliced lanes for interaction reads of unknown or slow sources. A source
 * sticks to one; more sources than lanes share them (reads of one source are
 * serial anyway).
 */
const SOURCE_LANES = 4;

/**
 * How long the main connection must stay idle before a lane runs its next
 * slice. Longer than the JS gap between two statements of a dependent chain
 * (one settles, the next is built and sent), so the chain runs unbroken
 * instead of letting one slice in at every gap.
 */
const MAIN_QUIET_MS = 2;

/**
 * While the main connection works, all lanes together get one slice per this
 * many ms: half the worker at 5 ms slices. A slow source keeps a minimum
 * rate, and a fast query waits at most one slice for it. One budget for
 * every lane, the background lane too: a budget per lane would let five busy
 * lanes take the whole worker between them.
 *
 * Measured beside a slow chart during a brush (/test/query-load?slow=1,
 * scripted drag, two runs each): the fast charts' p90 stayed at ~20 ms and
 * their updates the same at 25, 15 and 10 ms (their cost follows the slow
 * chart's large results decoding, not the share), while the slow chart's
 * data age fell from ~500 to ~375 to ~345 ms median.
 */
const SLICE_SHARE_MS = 10;

export interface QueryEngineOptions {
	/** Overrides BUILD_MAX_WAIT_MS; tests use it to make the queue deterministic. */
	buildMaxWaitMs?: number;
	/**
	 * Advanced. While the main connection works, all sliced lanes together get
	 * one slice per this many ms (see SLICE_SHARE_MS, the default).
	 */
	sliceShareMs?: number;
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
	/**
	 * Open another connection on the same database whose statements run
	 * sliced (see SlicedLane): a slow read there no longer blocks this
	 * connection's queries. DuckDB-WASM via `connectionFrom`; a connection
	 * without it keeps everything on itself. The engine opens lanes itself and
	 * sends through them from `#send`, so every statement keeps its record,
	 * class and accounting; nothing hands a raw lane to an app.
	 */
	openSlicedLane?(options?: { hold?: LaneHold }): Promise<SlicedLane>;
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
	/** What routing needs to know about the mark. Absent in tests that route nothing. */
	route?: MarkRoute;
	/**
	 * The mark is known to be slow (`holdsEntrance={false}`): its data reads
	 * go sliced from the first, whatever its source's cost. The mark, not its
	 * source: other marks on a fast table keep reading on the main connection.
	 */
	slow?: boolean;
}

interface MarkRegistration {
	descriptor: QueryDescriptor;
	handle: MarkHandle;
	filterGroup: FilterGroup;
	/** A re-query was skipped while the mark was inactive; run it on activation. */
	stale: boolean;
	/**
	 * The registration's first query has not been sent: a new mark, or one
	 * registered again with different query parts (a rebin, a field change).
	 * That first result can feed domains other charts share, so it goes out
	 * even while the mark is inactive.
	 */
	needsFirst: boolean;
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

/**
 * DuckDB's catalog error for a table or view this connection cannot see.
 * Matched by its wording, which an upgrade could change: the integration
 * test missing-relation.integration.test.ts checks it against real DuckDB.
 */
export function isMissingRelation(e: unknown): boolean {
	const message = e instanceof Error ? e.message : String(e);
	return /Catalog Error: (Table|View) with name .+ does not exist/i.test(message);
}

export class QueryEngine {
	#conn: DuckDBConnection | null = null;
	#connPromise: Promise<DuckDBConnection> | null = null;
	#inflight = new Map<string, AbortController>();
	#pending = new Map<
		string,
		{
			sql: string;
			resolve: (t: Table) => void;
			reject: (e: Error) => void;
			cache: boolean;
			place: StatementPlacement;
		}
	>();
	/** Interaction statements handed to the connection and not yet settled (see #send). */
	#interactionInFlight = 0;
	/** Debug listeners for every statement sent (observeStatements). */
	#statementObservers = new Set<(record: StatementRecord) => void>();
	#describeCache = new Map<string, Promise<ColumnInfo[]>>();
	#marks = new Map<string, MarkRegistration>();
	#destroyed = false;
	/** Each mark's preagg tables, the build queue and the size guard (see Preagg). */
	#preagg: Preagg;
	/** When a filter last changed, in any group (performance.now()). */
	#lastFilterChangeAt = 0;
	/**
	 * LRU query cache: Arrow Table (or Promise<Table> while inflight), keyed by
	 * `#cacheKey`, the SQL text and the dims' version. A mark's query reads dim
	 * tables (dense padding pads every category the dim holds), and dims grow
	 * after the first queries run: a table folding in, a topN mark reserving its
	 * Other. The text does not change when they do, so keyed by text alone the
	 * cache served a result from before, with fewer rows: the row set changed
	 * between updates and the bars snapped instead of morphing.
	 */
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
				exec: (sql, signal) => this.exec(sql, { class: 'background', signal }),
				query: (sql, opts) => this.query(sql, { class: 'background', ...opts }),
				// A statement someone waits for is on the connection, or a mark
				// query is waiting to be sent.
				busy: () => this.#interactionInFlight > 0 || this.#pending.size > 0,
				sliced: () => this.#slicedReady(),
				identity: this.#identity,
				mark: (markId) => this.#marks.get(markId),
				marks: () => this.#marks
			},
			options.buildMaxWaitMs ?? BUILD_MAX_WAIT_MS
		);
		this.#sliceShareMs = options.sliceShareMs ?? SLICE_SHARE_MS;
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
	 * The field's categories as of now, in id order, without the synthetic Other
	 * buckets: a bucket is not a category of the data, and another chart's bucket
	 * must not appear on an axis, a facet or a colour legend that has none.
	 *
	 * With `table`, only the categories that table holds: the dim spans every
	 * table registering the field, and an axis over one table must not show a
	 * slot for a category only another has. Without it (a scale shared per field,
	 * like ordinal colour), every category of the dim.
	 *
	 * A snapshot, not the live array: for decoding ids, hold `identityFor(field)`.
	 */
	categoryValues(field: string, table?: string): DimValue[] {
		const identity = this.#identity.identity(field);
		const values = identity.values;
		const present = table ? this.#identity.presentIds(field, table) : null;
		if (identity.synthetic.size === 0 && !present) return values.slice();
		const out: DimValue[] = [];
		for (let id = 0; id < values.length; id++) {
			if (identity.synthetic.has(id)) continue;
			if (present && !present.has(id)) continue;
			out.push(values[id]);
		}
		return out;
	}

	/**
	 * The table of ids `table` holds for `field`, for `dense()` to pad from, or
	 * null before the table has folded into the field's dim.
	 */
	presentTableFor(field: string, table: string): string | null {
		return this.#identity.presentTable(field, table);
	}

	/**
	 * The field's id <-> value bijection. One live object owning both
	 * directions, so a holder cannot end up with a value array and a reverse map
	 * that disagree. Prefer this over categoryValues() anywhere the reverse
	 * direction is needed; do not rebuild it locally.
	 */
	identityFor(field: string): FieldIdentity {
		return this.#identity.identity(field);
	}

	/** The field's current bijection, or null; never creates one (see CategoricalIdentity). */
	peekIdentity(field: string): FieldIdentity | null {
		return this.#identity.peekIdentity(field);
	}

	/**
	 * Acquire an id for a value present in no table — the synthetic "Other"
	 * bucket from `topN({ includeOthers })` — with the label it displays. Call
	 * after ensureColumns; release it when its holder goes.
	 */
	acquireSyntheticIdentity(field: string, label: string): Promise<SyntheticId> {
		return this.#identity.acquireSynthetic(field, label);
	}

	/** Give back an id from `acquireSyntheticIdentity`, for the next acquire to reuse. */
	releaseSyntheticIdentity(synthetic: SyntheticId): void {
		this.#identity.releaseSynthetic(synthetic);
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
	 * The one place a statement reaches the connection. Everything that talks to
	 * DuckDB goes through here: queries, statements, DESCRIBE, Arrow inserts.
	 *
	 * What attaches here: the interaction count builds yield to, and statement
	 * observers (debugging, measurement). Later: routing a class to a connection,
	 * and per-connection queues.
	 */
	async #send<T>(
		kind: StatementRecord['kind'],
		sql: string,
		place: StatementPlacement,
		how: {
			run: (conn: DuckDBConnection) => Promise<T>;
			/** How to run it on a sliced lane; absent: main connection only. */
			runSliced?: (lane: SlicedLane) => Promise<T>;
			signal?: AbortSignal;
		}
	): Promise<T> {
		const { run, runSliced, signal } = how;
		if (!this.#conn) await this.#ensureConnection();
		const cls = place.class;
		// Awaited only while a lane is opening (LaneSlot.get): once its state is
		// known the choice is made in this tick.
		const slot = runSliced ? this.#slotFor(place) : null;
		const got = slot ? slot.get() : null;
		const lane = got instanceof Promise ? await got : got;
		// The main connection cannot interrupt a statement once sent: a signal
		// only stops one that has not gone yet. A lane cancels (SlicedLane).
		if (!lane && signal?.aborted) throw new DOMException('Statement aborted', 'AbortError');
		const conn = this.#conn!;
		const interaction = cls === 'interaction';
		if (interaction) this.#interactionInFlight++;
		const start = performance.now();
		let error: unknown;
		// Paired with #mainIdle in the finally below.
		if (!lane) this.#mainBusy();
		try {
			return lane ? await runSliced!(lane) : await run(conn);
		} catch (e) {
			error = e;
			throw e;
		} finally {
			if (this.#statementObservers.size > 0) {
				const record: StatementRecord = {
					sql,
					kind,
					class: cls,
					connection: lane ? 'lane' : 'main',
					source: place.source,
					requested: place.requestedAt,
					caller: place.callerId,
					start,
					end: performance.now(),
					error
				};
				// A listener is for debugging: one that throws must not fail the
				// statement, nor skip the in-flight count below.
				for (const observe of this.#statementObservers) {
					try {
						observe(record);
					} catch (e) {
						console.error('[QueryEngine] statement observer threw:', e);
					}
				}
			}
			if (!lane) this.#mainIdle();
			// The last interaction statement settling frees the connection for a build.
			if (interaction && --this.#interactionInFlight === 0) this.#preagg.pump();
		}
	}

	/**
	 * Execute a SQL query and return a flechette Table.
	 * Uses the fast IPC path (queryIPC → tableFromIPC) when available,
	 * falling back to the standard conn.query() for mocks/testing.
	 */
	#queryRaw(
		sql: string,
		place: StatementPlacement,
		kind: StatementRecord['kind'] = 'query',
		signal?: AbortSignal
	): Promise<Table> {
		let sliced = false;
		const read = this.#send(kind, sql, place, {
			run: async (conn) => {
				if (!conn.queryIPC) return conn.query(sql);
				const t0 = performance.now();
				const bytes = await conn.queryIPC(sql);
				const ms = performance.now() - t0;
				const table = tableFromIPC(bytes);
				if (this.#notesCost(place)) this.#routing.noteMainRead(place.source!, ms, table.numRows);
				return table;
			},
			runSliced: async (lane) => {
				sliced = true;
				const result: LaneResult = await lane.query(sql, signal);
				const table = tableFromIPC(result.ipc);
				if (this.#notesCost(place)) {
					this.#routing.noteLaneRead(place.source!, result.polls, result.execMs, table.numRows);
				}
				return table;
			},
			signal
		});
		// Safety net for a TEMP source made where the engine could not see it
		// (on the app's connection, which is the main one): a lane does not
		// have it. Once found missing there, it stays on the main connection
		// for good, and this read is sent there. Local is the safe direction:
		// a race (a lane read during a drop and re-create made outside the
		// engine) can only make a source less sliced, which is how every
		// source read before lanes.
		return read.catch((e) => {
			const source = place.source;
			if (!sliced || !source || !isMissingRelation(e)) throw e;
			this.#localSources.add(source);
			return this.#queryRaw(sql, place, kind, signal);
		});
	}

	/**
	 * The lane a statement runs on, or null for the main connection:
	 * - connection-local state, or a statement with no sliced form: main;
	 * - background: the background lane (preagg builds and their reads);
	 * - interaction naming a source: by the source's cost (SourceRouting),
	 *   unknown or slow on that source's lane, known-fast on main.
	 * Without the capability every slot answers null: one connection.
	 */
	#slotFor(place: StatementPlacement): LaneSlot | null {
		if (place.connectionLocal) return null;
		if (place.class === 'background') return this.#backgroundLane;
		if (!place.source || !this.#conn?.openSlicedLane) return null;
		if (this.#localSources.has(place.source)) return null;
		const i = place.slow ? this.#routing.laneOf(place.source) : this.#routing.route(place.source);
		return i == null ? null : this.#sourceLanes[i];
	}

	/** Whether a read's cost goes into its source's record: interaction data reads. */
	#notesCost(place: StatementPlacement): boolean {
		// A read known to be slow says nothing about its source: a slow mark's
		// heavy query would otherwise turn a fast table slow for every mark.
		return place.class === 'interaction' && !!place.data && !!place.source && !place.slow;
	}

	/**
	 * Whether background statements run sliced, on their own connection, so
	 * they no longer hold up interaction. Asks for the lane, so the first ask
	 * opens it; false until it is open.
	 */
	#slicedReady(): boolean {
		this.#backgroundLane.get();
		return this.#backgroundLane.isOpen;
	}

	#openLaneFn = (): Promise<SlicedLane> | null => {
		const conn = this.#conn;
		if (!conn?.openSlicedLane || this.#destroyed) return null;
		return conn.openSlicedLane({ hold: this.#sliceGrant });
	};

	// --- Holding lanes while the main connection works ---
	//
	// A lane's slice is a message at the back of the worker's queue, so it
	// runs between two main-connection statements; in a dependent chain (a
	// mark's setup: dims, views, then data) every step then waits a slice.
	// So while the main connection works, lanes share a budget of slices
	// (SLICE_SHARE_MS, across all of them); once it has been idle for
	// MAIN_QUIET_MS they run freely. Counted here, per connection: a slow
	// source's reads are interaction class too, and a lane waiting on
	// #interactionInFlight would wait for itself.

	/** Statements on the main connection, sent and not settled. */
	#mainInFlight = 0;
	/** When the main connection last went idle. */
	#mainIdleAt = 0;
	#sliceShareMs: number;
	/** When any lane last took a slice from the share. */
	#lastSliceAt = -Infinity;
	/** Lanes waiting for a slice, first come first served. */
	#sliceWaiters: (() => void)[] = [];
	#shareTimer: ReturnType<typeof setTimeout> | null = null;
	#quietTimer: ReturnType<typeof setTimeout> | null = null;

	#mainBusy(): void {
		this.#mainInFlight++;
		if (this.#quietTimer) {
			clearTimeout(this.#quietTimer);
			this.#quietTimer = null;
		}
	}

	#mainIdle(): void {
		if (--this.#mainInFlight > 0) return;
		this.#mainIdleAt = performance.now();
		if (this.#sliceWaiters.length > 0) this.#armQuiet();
	}

	#mainQuietNow(): boolean {
		return this.#mainInFlight === 0 && performance.now() - this.#mainIdleAt >= MAIN_QUIET_MS;
	}

	/** Once the main connection has stayed idle long enough, every waiting lane goes. */
	#armQuiet(): void {
		if (this.#quietTimer) clearTimeout(this.#quietTimer);
		const left = MAIN_QUIET_MS - (performance.now() - this.#mainIdleAt);
		this.#quietTimer = setTimeout(
			() => {
				this.#quietTimer = null;
				if (this.#mainInFlight > 0) return;
				const waiting = this.#sliceWaiters;
				this.#sliceWaiters = [];
				for (const go of waiting) go();
			},
			Math.max(0, left)
		);
	}

	/** The next waiting lane gets the share's next slice. */
	#armShare(): void {
		if (this.#shareTimer) return;
		const left = this.#lastSliceAt + this.#sliceShareMs - performance.now();
		this.#shareTimer = setTimeout(
			() => {
				this.#shareTimer = null;
				const go = this.#sliceWaiters.shift();
				if (!go) return;
				this.#lastSliceAt = performance.now();
				go();
				if (this.#sliceWaiters.length > 0) this.#armShare();
			},
			Math.max(0, left)
		);
	}

	/** LaneHold: may a lane run its next slice now? */
	#sliceGrant: LaneHold = () => {
		if (this.#mainQuietNow()) return null;
		const now = performance.now();
		if (this.#sliceWaiters.length === 0 && now - this.#lastSliceAt >= this.#sliceShareMs) {
			this.#lastSliceAt = now;
			return null;
		}
		return new Promise<void>((resolve) => {
			this.#sliceWaiters.push(resolve);
			this.#armShare();
			if (this.#mainInFlight === 0) this.#armQuiet();
		});
	};
	#laneFailed = (e: unknown): void => {
		if (this.#warnedLaneFailed) return;
		this.#warnedLaneFailed = true;
		console.warn(
			'[QueryEngine] could not open a sliced lane; its statements stay on the main connection:',
			e
		);
	};
	#warnedLaneFailed = false;
	/** Background statements: preagg builds, their counts and drops. */
	#backgroundLane = new LaneSlot(this.#openLaneFn, this.#laneFailed);
	/** Interaction reads of unknown and slow sources, a source sticking to one. */
	#sourceLanes = Array.from(
		{ length: SOURCE_LANES },
		() => new LaneSlot(this.#openLaneFn, this.#laneFailed)
	);
	#routing = new SourceRouting(SOURCE_LANES);

	/**
	 * Listen to every statement sent to the connection, as it settles. For
	 * debugging and measurement; returns the unsubscribe. Costs nothing while
	 * no one listens.
	 */
	observeStatements(listener: (record: StatementRecord) => void): () => void {
		this.#statementObservers.add(listener);
		return () => this.#statementObservers.delete(listener);
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
		const place: StatementPlacement = {
			class: opts?.class ?? 'interaction',
			connectionLocal: opts?.connectionLocal,
			source: opts?.source,
			data: opts?.data,
			requestedAt: performance.now(),
			callerId: opts?.callerId,
			slow: opts?.slow
		};

		// Cache check: return cached result immediately, bypassing
		// inflight/pending bookkeeping entirely.
		// Opt out with cache: false for queries against volatile temp tables.
		const useCache = opts?.cache !== false;
		if (useCache) {
			const cached = this.#queryCache.get(this.#cacheKey(sqlStr));
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
					this.#pending.set(callerId, {
						sql: sqlStr,
						resolve,
						reject,
						cache: useCache,
						place
					});
				});
			}

			return this.#executeForCaller(callerId, sqlStr, opts.signal, useCache, place);
		}

		// No callerId, cache asked for: the first caller's promise goes in the
		// cache, so a concurrent identical query (two marks asking the same
		// range) shares it, and a later one reads the result. A cached hit
		// already returned above.
		if (opts?.cache === true) {
			if (opts.signal?.aborted) throw new DOMException('Query aborted', 'AbortError');
			const key = this.#cacheKey(sqlStr);
			const promise = this.#queryRaw(sqlStr, place, 'query', opts.signal);
			this.#queryCache.set(key, promise);
			let result: Table;
			try {
				result = await promise;
				this.#queryCache.set(key, result);
			} catch (e) {
				this.#queryCache.delete(key);
				throw e;
			}
			// Aborted while running: the result stays cached for others (it is
			// correct), but this caller asked not to receive it.
			if (opts.signal?.aborted) throw new DOMException('Query aborted', 'AbortError');
			return result;
		}

		// No callerId: direct execution, still respect external signal
		if (opts?.signal) {
			if (opts.signal.aborted) {
				throw new DOMException('Query aborted', 'AbortError');
			}
			const result = await this.#queryRaw(sqlStr, place, 'query', opts.signal);
			if (opts.signal.aborted) {
				throw new DOMException('Query aborted', 'AbortError');
			}
			return result;
		}

		return this.#queryRaw(sqlStr, place);
	}

	/**
	 * The cache key for a query: its text and the dims' version, so a result read
	 * against a dim that has since grown is not served again.
	 */
	#cacheKey(sqlStr: string): string {
		return `${this.#identity.version}\u0000${sqlStr}`;
	}

	async #executeForCaller(
		callerId: string,
		sqlStr: string,
		signal?: AbortSignal,
		cache: boolean = true,
		place: StatementPlacement = { class: 'interaction' }
	): Promise<Table> {
		const controller = new AbortController();
		this.#inflight.set(callerId, controller);
		let key: string | null = null;

		if (signal) {
			signal.addEventListener('abort', () => controller.abort(), { once: true });
		}

		try {
			if (controller.signal.aborted) {
				throw new DOMException('Query superseded', 'AbortError');
			}

			// Keyed when it runs, not when it was asked for: a pending query runs
			// later, against whatever the dims hold by then.
			key = this.#cacheKey(sqlStr);

			// Cache the Promise so concurrent identical queries share one inflight
			const queryPromise = this.#queryRaw(sqlStr, place, 'query', controller.signal);
			if (cache) this.#queryCache.set(key, queryPromise);

			const result = await queryPromise;

			// Replace Promise with resolved data for future lookups
			if (cache) this.#queryCache.set(key, result);

			if (controller.signal.aborted) {
				// Don't cache results from aborted queries
				this.#queryCache.delete(key);
				throw new DOMException('Query superseded', 'AbortError');
			}

			return result;
		} catch (e) {
			// Remove failed query from cache so we don't serve a rejected Promise
			if (key !== null) this.#queryCache.delete(key);
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
				this.#executeForCaller(callerId, pending.sql, undefined, pending.cache, pending.place)
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
	async exec(
		sql: string | string[],
		opts?: { class?: StatementClass; connectionLocal?: boolean; signal?: AbortSignal }
	): Promise<void> {
		if (this.#destroyed) {
			throw new Error('QueryEngine has been destroyed');
		}
		const place: StatementPlacement = {
			class: opts?.class ?? 'interaction',
			connectionLocal: opts?.connectionLocal
		};
		const signal = opts?.signal;
		const statements = Array.isArray(sql) ? sql : [sql];
		// One statement at a time, each committing on its own.
		for (const stmt of statements) {
			await this.#send('exec', stmt, place, {
				run: async (conn) => {
					if (conn.exec) await conn.exec(stmt);
					else await conn.query(stmt);
				},
				runSliced: async (lane) => {
					await lane.exec(stmt, signal);
				},
				signal
			});
			this.#noteDDL(stmt);
		}
	}

	/**
	 * Learn what a source is from the statement that made it (SourceRouting's
	 * prior), at no cost: a table created under a plain name starts fast, a
	 * view unknown, a dropped name forgets. Covers everything created through
	 * the engine (loadParquet, Arrow inserts, fjader's own tables); a source
	 * made elsewhere falls back to the catalog (#classifySource).
	 */
	#noteDDL(sql: string): void {
		const ddl = sourceDDL(sql);
		if (!ddl) return;
		if (ddl.kind === 'drop') {
			this.#known.delete(ddl.name);
			this.#localSources.delete(ddl.name);
			this.#routing.forget(ddl.name);
			return;
		}
		this.#known.set(ddl.name, ddl.kind);
		if (ddl.temp) this.#localSources.add(ddl.name);
		else this.#localSources.delete(ddl.name);
		// Replacing a name re-opens its record: a view over a table, a new table.
		this.#routing.forget(ddl.name);
		if (ddl.kind === 'table') this.#routing.prior(ddl.name, 'fast');
	}

	/** Sources seen created through the engine, by name. */
	#known = new Map<string, 'table' | 'view'>();
	/**
	 * Sources that exist only on the main connection: TEMP tables and views
	 * (they belong to the connection that made them), whether seen created
	 * through the engine or found missing on a lane. Never routed to a lane,
	 * whatever their cost.
	 */
	#localSources = new Set<string>();

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
		// A failure is not remembered: a DESCRIBE sent before its table existed
		// would otherwise fail every later one for good.
		promise.catch(() => {
			if (this.#describeCache.get(table) === promise) this.#describeCache.delete(table);
		});
		return promise;
	}

	async #fetchDescribe(table: string): Promise<ColumnInfo[]> {
		const escaped = table.replaceAll('"', '""');
		// A source not seen created through the engine is looked up in the
		// catalog, off the critical path: until the answer it reads sliced.
		void this.#classifySource(table);
		const result = await this.#queryRaw(
			`DESCRIBE "${escaped}"`,
			{ class: 'interaction' },
			'describe'
		);
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
	 * Set a source's prior from what it is (SourceRouting): a base or
	 * temporary table in an in-memory catalog starts fast; a view, or a
	 * table in an attached database with a path (a file, a URL), stays
	 * unknown and is read sliced until measured. Only where lanes exist: a
	 * single connection has nothing to route.
	 */
	async #classifySource(table: string): Promise<void> {
		if (!this.#conn?.openSlicedLane) return;
		if (this.#known.has(table)) return;
		let known = this.#catalog?.get(table);
		if (known === undefined) known = (await this.#refreshCatalog()).get(table);
		if (known === 'fast') this.#routing.prior(table, 'fast');
	}

	/**
	 * Every user table, by name: 'fast' when every catalog holding that name
	 * is in memory, 'unknown' otherwise. A name not in it (a view, a table
	 * function) stays unknown, so the views need not be listed: duckdb_views()
	 * enumerates DuckDB's internal views before any filter and was most of
	 * the cost (information_schema per table: 30-38 ms at load on WASM;
	 * tables and views together still 33-41 ms; tables and databases alone
	 * about a quarter of that, natively). Refreshed when a name is missing;
	 * concurrent misses (a dozen marks mounting) share the refresh in flight.
	 */
	#refreshCatalog(): Promise<Map<string, 'fast' | 'unknown'>> {
		this.#catalogRefresh ??= this.#queryRaw(
			`SELECT t.table_name AS name, d.path AS path FROM duckdb_tables() t ` +
				`JOIN duckdb_databases() d ON d.database_name = t.database_name WHERE NOT t.internal`,
			{ class: 'interaction' }
		)
			.then((rows) => {
				const catalog = new Map<string, 'fast' | 'unknown'>();
				for (let i = 0; i < rows.numRows; i++) {
					const row = rows.get(i) as { name: string; path: string | null };
					const inMemory = !row.path || row.path === ':memory:';
					// A name in two catalogs is fast only if every one is.
					if (catalog.get(row.name) !== 'unknown') {
						catalog.set(row.name, inMemory ? 'fast' : 'unknown');
					}
				}
				this.#catalog = catalog;
				return catalog;
			})
			.catch(() => this.#catalog ?? new Map<string, 'fast' | 'unknown'>())
			.finally(() => {
				this.#catalogRefresh = null;
			});
		return this.#catalogRefresh;
	}

	#catalog: Map<string, 'fast' | 'unknown'> | null = null;
	#catalogRefresh: Promise<Map<string, 'fast' | 'unknown'>> | null = null;

	/**
	 * Tell the engine how a source reads, overriding its prior: `'slow'` for a
	 * table that is slow to query (it reads sliced, so it never holds up
	 * other charts), `'fast'` for a view that is cheap (it reads on the main
	 * connection from its first query). A measured read still corrects it.
	 */
	sourceCost(source: string, cost: 'fast' | 'slow'): void {
		this.#routing.hint(source, cost);
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
		// New data: a source's cost is unknown again (a reload can be slower),
		// and the catalog is read again.
		this.#routing.reset();
		this.#catalog = null;
		// Tables learned from DDL are still tables: their prior comes back
		// (#classifySource skips names it already knows).
		for (const [name, kind] of this.#known) {
			if (kind === 'table') this.#routing.prior(name, 'fast');
		}
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
		await this.#send(
			'insert',
			`INSERT ARROW INTO "${options.name}" (${data.byteLength} bytes)`,
			{ class: 'interaction' },
			{
				run: async (conn) => {
					if (!conn.insertArrowFromIPCStream) {
						throw new Error('Arrow IPC loading requires a DuckDB-WASM connection');
					}
					await conn.insertArrowFromIPCStream(data, options);
				}
			}
		);
		// The notebook widget's load path: a table made from Arrow is a table.
		if (options.create) this.#noteDDL(`CREATE TABLE "${options.name.replaceAll('"', '""')}" (x)`);
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
		const reg: MarkRegistration = {
			descriptor,
			handle,
			filterGroup,
			stale: false,
			needsFirst: !prev || prev.descriptor.parts !== descriptor.parts
		};
		this.#marks.set(markId, reg);
		this.#preagg.trackTable(descriptor.baseTable);

		handle._onParamsChange = () => this.#queryMark(markId, reg);
		handle._onActivate = () => {
			if (!reg.stale) return false;
			reg.stale = false;
			this.#queryMark(markId, reg, 'catchUp');
			return true;
		};

		handle.destroy = () => {
			this.cancel(markId);
			this.#preagg.dropMark(markId);
			this.#marks.delete(markId);
			handle._onParamsChange = null;
			handle._onActivate = null;
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
	 * Called by FilterGroup when its clauses change wholesale (clearAll):
	 * re-queries every mark in the group.
	 */
	onFilterChange(group: FilterGroup): void {
		this.#lastFilterChangeAt = performance.now();
		for (const [markId, reg] of this.#marks) {
			if (reg.filterGroup === group) this.#queryMark(markId, reg);
		}
	}

	/**
	 * Called by FilterGroup when the clause of `sourceId` changes: `prev` is the
	 * clause it replaced or removed, `next` the one now in force (null when
	 * removed).
	 *
	 * Re-queries only the group's marks that either one filters. A mark neither
	 * filters has the same SQL as before, so querying it would only assemble that
	 * SQL to find the cached result, on every brush frame. A mark that reads the
	 * clause's categorical field dims by it instead, and a mark in a chart that
	 * skips the source is not filtered by it: neither is re-queried.
	 */
	onClauseChange(
		group: FilterGroup,
		sourceId: string,
		prev: Clause | undefined,
		next: Clause | null
	): void {
		this.#lastFilterChangeAt = performance.now();
		const { selection } = group;
		for (const [markId, reg] of this.#marks) {
			if (reg.filterGroup !== group) continue;
			const route = reg.descriptor.route ?? NO_ROUTE;
			if (
				(prev && selection.applies(sourceId, prev, route)) ||
				(next && selection.applies(sourceId, next, route))
			) {
				this.#queryMark(markId, reg);
			}
		}
	}

	/**
	 * Called by FilterGroup when a registration that skips `chart` comes or
	 * goes while its source has a clause: re-queries the group's marks in that
	 * chart, whose filters may have changed. A mark whose SQL did not change
	 * stops at the cache and the same-Table guard.
	 */
	onChartRouteChange(group: FilterGroup, chart: object): void {
		for (const [markId, reg] of this.#marks) {
			if (reg.filterGroup === group && reg.descriptor.route?.chart === chart) {
				this.#queryMark(markId, reg);
			}
		}
	}

	/**
	 * Query a single mark: on a filter change or a params
	 * change (via _onParamsChange). Reads a preagg table when one answers; if
	 * that read fails, the table is set aside and the base table is queried once.
	 *
	 * `cause` travels with this query's own promise chain to `_setResult`, not
	 * on the handle: a catch-up in flight and an update waiting behind it are
	 * two chains, so each result lands with its own cause. A filter change
	 * during a catch-up lets the catch-up land (without animating) and the
	 * update then animates from there; a superseded pending query rejects, and
	 * its chain sets nothing.
	 */
	#queryMark(markId: string, reg: MarkRegistration, cause: ResultCause = 'update'): void {
		const { handle } = reg;
		// Off screen and already holding data for this registration: nothing to
		// show for it now. A registration's first query still runs (it can feed
		// a domain another chart shares), including after a re-registration
		// with new parts, where the handle still holds the old data.
		if (!handle.active && handle.dataVersion > 0 && !reg.needsFirst) {
			reg.stale = true;
			return;
		}
		reg.stale = false;
		const preagg = this.#preagg.sqlFor(markId, reg);
		const sqlStr = preagg?.sql || this.#baseSQL(markId, reg);
		if (!sqlStr) return;
		// Only once a first query actually goes out.
		reg.needsFirst = false;

		// Use the public query() path — its execute-latest logic ensures
		// at most 1 inflight + 1 pending per callerId during rapid brushing.
		// A preagg table is built in memory by fjader: fast until measured.
		if (preagg) this.#routing.prior(preagg.table, 'fast');
		// Routed by the table this read reads (SourceRouting): the preagg table
		// when one answers, else the mark's BASE table. Its identity view reads
		// the same rows, and the mark's range and stats reads name the base
		// table: one record per source, kept by the data reads.
		this.query(sqlStr, {
			callerId: markId,
			source: preagg?.table ?? reg.descriptor.baseTable,
			data: true,
			slow: reg.descriptor.slow
		})
			.catch((e) => {
				if (!preagg || (e as Error)?.name === 'AbortError') throw e;
				this.#preagg.readFailed(markId, preagg.table, e);
				const baseSQL = this.#baseSQL(markId, reg);
				if (!baseSQL) throw e;
				return this.query(baseSQL, {
					callerId: markId,
					source: reg.descriptor.baseTable,
					data: true,
					slow: reg.descriptor.slow
				});
			})
			.then((table) => handle._setResult(table, cause))
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
			reg.filterGroup.selection.predicate(reg.descriptor.route ?? NO_ROUTE),
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
		// The preagg drops above ran on the lane; close it, then the connection.
		await Promise.all([this.#backgroundLane, ...this.#sourceLanes].map((slot) => slot.close()));
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
