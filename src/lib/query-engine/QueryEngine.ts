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
	column,
	and,
	isBetween,
	literal,
	Query,
	type ExprNode
} from '@uwdata/mosaic-sql';
import { rewriteForPreagg, buildBinExpr, type BrushActivation } from './sufficient-statistics';
export type { BrushActivation } from './sufficient-statistics';
import {
	assembleQuery,
	castNumeric,
	castReal,
	splitWindowSelect,
	type QueryParts
} from '$lib/components/marks/lifecycle/query-builder';
import { MarkHandle, type QueryParams } from './MarkHandle.svelte';
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

/** Map a DuckDB SQL type string to a JS type category. */
export function mapSqlTypeToJs(sqlType: string): JsColumnType {
	const upper = (sqlType || '').toUpperCase();
	if (/INT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|BIGINT|SMALLINT|TINYINT|HUGEINT/.test(upper)) return 'number';
	if (/DATE|TIME|TIMESTAMP|INTERVAL/.test(upper)) return 'date';
	if (/BOOL/.test(upper)) return 'boolean';
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
	table: string;
	parts: QueryParts;
	schema: Map<string, ColumnSchema>;
	transformCompiler: TransformCompiler;
}

interface MarkRegistration {
	descriptor: QueryDescriptor;
	handle: MarkHandle;
	filterGroup: FilterGroup;
	preaggTable: string | null;
	preaggReady: boolean;
	lastPreaggParts: QueryParts | null;
	/** Rewritten select expressions that recombine partials at query time. */
	preaggOutputSelect: Record<string, ExprNode> | null;
	/** Bin dimension metadata for computing bin filters at query time. */
	preaggBinMeta: Array<{ alias: string; d0: number; scaleFactor: number }> | null;
	/** Mark IDs of the source chart (for identifying active-source clauses). */
	preaggSourceChartMarkIds: Set<string> | null;
	/** Window channels needing CTE wrapping in the preagg query. */
	preaggWindowChannels: Record<string, import('@uwdata/mosaic-sql').WindowNode> | null;
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export class QueryEngine {
	#conn: DuckDBConnection | null = null;
	#connPromise: Promise<DuckDBConnection> | null = null;
	#inflight = new Map<string, AbortController>();
	#pending = new Map<string, { sql: string; resolve: (t: Table) => void; reject: (e: Error) => void; cache: boolean }>();
	#describeCache = new Map<string, Promise<ColumnInfo[]>>();
	#marks = new Map<string, MarkRegistration>();
	#destroyed = false;
	/** Active source IDs for the current preagg session. */
	#activeSourceIds: Set<string> | null = null;
	/** Source chart mark IDs from the last activate() call. */
	#lastSourceChartMarkIds: Set<string> | null = null;
	/** Hash-named preagg tables created this session (for cleanup on destroy). */
	#preaggTables = new Set<string>();
	/** LRU query cache: SQL string → Arrow Table (or Promise<Table> while inflight). */
	#queryCache = lruCache<Table>({ max: 1000, ttl: 3 * 60 * 60 * 1000 });

	constructor(connection: DuckDBConnection | Promise<DuckDBConnection>) {
		if (connection instanceof Promise) {
			this.#connPromise = connection;
			connection.then((c) => {
				this.#conn = c;
			});
		} else {
			this.#conn = connection;
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

	async #executeForCaller(callerId: string, sqlStr: string, signal?: AbortSignal, cache: boolean = true): Promise<Table> {
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
	 * indefinitely). Registered marks are left as-is — this only invalidates
	 * caches; callers still need to trigger a re-query (e.g. a filter change)
	 * to see fresh data rendered.
	 */
	clearQueryCache(): void {
		this.clearDescribeCache();
		for (const reg of this.#marks.values()) {
			this.#dropPreagg(reg);
		}
		for (const preaggTable of this.#preaggTables) {
			this.exec(`DROP TABLE IF EXISTS "${preaggTable}"`).catch(() => {});
		}
		this.#preaggTables.clear();
		this.#queryCache.clear();
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
	registerMark(
		markId: string,
		descriptor: QueryDescriptor,
		filterGroup: FilterGroup
	): MarkHandle {
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
			preaggTable: null,
			preaggReady: false,
			lastPreaggParts: null,
			preaggOutputSelect: null,
			preaggBinMeta: null,
			preaggSourceChartMarkIds: null,
			preaggWindowChannels: null
		};
		this.#marks.set(markId, reg);

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

	/**
	 * Called by FilterGroup when any filter clause changes.
	 * Iterates registered marks for this group and batch-queries them.
	 */
	onFilterChange(group: FilterGroup): void {
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

			// Preagg routing: use preagg table if available and parts haven't changed.
			// Reference equality — $derived memoization ensures same object when
			// dependencies don't change.
			const usePreagg =
				PREAGG_ENABLED &&
				reg.preaggReady &&
				reg.preaggTable &&
				descriptor.parts === reg.lastPreaggParts;

			const sqlStr = usePreagg
				? this.#assemblePreaggSQL(markId, reg, handle.params)
				: this.#assembleSQL(descriptor, descriptor.table, selection.predicate(markId), handle.params);
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

		const usePreagg =
			PREAGG_ENABLED &&
			reg.preaggReady &&
			reg.preaggTable &&
			descriptor.parts === reg.lastPreaggParts;

		const sqlStr = usePreagg
			? this.#assemblePreaggSQL(markId, reg, handle.params)
			: this.#assembleSQL(descriptor, descriptor.table, reg.filterGroup.selection.predicate(markId), handle.params);
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
	 * Pre-aggregate marks for a filter group before brushing begins.
	 * Called by interactors on pointerenter — before the first brush drag.
	 *
	 * Builds materialized preagg tables (temp tables) for all aggregate marks
	 * in the filter group that are NOT on the source chart. Each preagg table
	 * includes pixel-binned brush dimensions so brush queries operate on thousands of
	 * rows instead of hundreds of thousands.
	 */
	async activate(
		filterGroup: FilterGroup,
		sourceChartMarkIds: Set<string>,
		brushDims: BrushActivation[]
	): Promise<void> {
		if (this.#destroyed || brushDims.length === 0) return;

		// If the source chart changed (user hovered a different chart),
		// invalidate all preagg tables — they have stale sourceChartMarkIds and
		// potentially stale baked-in static filters.
		if (
			this.#lastSourceChartMarkIds &&
			!setsEqual(this.#lastSourceChartMarkIds, sourceChartMarkIds)
		) {
			for (const reg of this.#marks.values()) {
				if (reg.filterGroup === filterGroup) this.#dropPreagg(reg);
			}
		}
		this.#lastSourceChartMarkIds = sourceChartMarkIds;

		// Identify active source IDs: clauses whose excludeMarkIds intersect
		// with the source chart (i.e., the brush lives on this chart)
		const activeSourceIds = new Set<string>();
		for (const entry of filterGroup.selection.items) {
			for (const markId of entry.excludeMarkIds) {
				if (sourceChartMarkIds.has(markId)) {
					activeSourceIds.add(entry.sourceId);
					break;
				}
			}
		}

		// If active source IDs changed (e.g. a new brush appeared),
		// also invalidate preagg tables — baked-in static filters may be stale.
		if (this.#activeSourceIds && !setsEqual(this.#activeSourceIds, activeSourceIds)) {
			for (const reg of this.#marks.values()) {
				if (reg.filterGroup === filterGroup) this.#dropPreagg(reg);
			}
		}
		this.#activeSourceIds = activeSourceIds;

		const promises: Promise<void>[] = [];

		for (const [markId, reg] of this.#marks) {
			if (reg.filterGroup !== filterGroup) continue;
			if (sourceChartMarkIds.has(markId)) continue;

			// Skip if preagg still valid (same query parts, already built)
			if (reg.preaggReady && reg.descriptor.parts === reg.lastPreaggParts) continue;

			// Drop stale preagg
			this.#dropPreagg(reg);

			const { parts, table, schema } = reg.descriptor;
			if (!parts.hasAggregates && !parts.hasWindowAggregates) continue;

			// Analyze selectDef for preagg compatibility
			const analysis = rewriteForPreagg(parts.selectDef, parts.passthroughChannels);
			if (!analysis) continue; // unsupported (window/distinct)

			const { preaggCols, outputSelect, preaggGroupBy } = analysis;

			// Add pixel-binned brush dimensions to preagg table
			const binMeta: Array<{ alias: string; d0: number; scaleFactor: number }> = [];
			const binGroupBy: ExprNode[] = [];
			for (let i = 0; i < brushDims.length; i++) {
				const alias = `__active${i}`;
				const { expr, d0, scaleFactor } = buildBinExpr(
					brushDims[i].columnRef,
					brushDims[i].domain,
					brushDims[i].pixelExtent
				);
				preaggCols[alias] = expr;
				binGroupBy.push(column(alias));
				binMeta.push({ alias, d0, scaleFactor });
			}

			// CAST-wrap dimension preaggCols (bake CAST into the preagg table).
			// Partial-aggregate and bin columns stay raw for recombination.
			for (const [ch, expr] of Object.entries(preaggCols)) {
				if (ch.startsWith('__ps') || ch.startsWith('__active')) continue;
				if (isAggregateExpression(expr)) continue;
				preaggCols[ch] = castNumeric(expr, schema) as ExprNode;
			}

			// Bake non-active filters into the preagg table
			const staticFilters = filterGroup.selection.predicateExcluding(
				markId,
				activeSourceIds
			);

			// Build preagg creation query, sorted by active columns for fast range scans
			const preaggQuery = Query.from(table)
				.select(preaggCols as Record<string, ExprNode>)
				.groupby([...preaggGroupBy, ...binGroupBy] as ExprNode[])
				.orderby(binGroupBy as ExprNode[]);

			if (staticFilters.length > 0) {
				preaggQuery.where(and(staticFilters as ExprNode[]));
			}

			// Hash-based naming: identical preagg SQL reuses the same table (like Mosaic).
			// CREATE TABLE IF NOT EXISTS avoids rebuilding when switching charts.
			const preaggSQL = preaggQuery.toString();
			const preaggTable = `__dplot_preagg_${fnvHash(preaggSQL).toString(16)}`;
			const createSQL = `CREATE TABLE IF NOT EXISTS "${preaggTable}" AS ${preaggSQL}`;

			// Store rewrite info for query-time use
			reg.preaggOutputSelect = outputSelect;
			reg.preaggBinMeta = binMeta;
			reg.preaggSourceChartMarkIds = sourceChartMarkIds;
			reg.preaggWindowChannels = analysis.windowChannels;

			this.#preaggTables.add(preaggTable);
			promises.push(
				this.exec(createSQL)
					.then(() => {
						reg.preaggTable = preaggTable;
						reg.preaggReady = true;
						reg.lastPreaggParts = parts;
					})
					.catch((e) => {
						console.warn(`[QueryEngine] preagg failed for ${markId}:`, e);
						this.#dropPreagg(reg);
					})
			);
		}

		await Promise.all(promises);
	}

	/**
	 * Assemble SQL for a preagg brush query.
	 * Builds modified QueryParts from the stored outputSelect + bin filters,
	 * then delegates to assembleQuery().
	 */
	#assemblePreaggSQL(
		markId: string,
		reg: MarkRegistration,
		params: QueryParams
	): string | null {
		const { preaggTable, preaggOutputSelect, preaggBinMeta, preaggSourceChartMarkIds } = reg;
		if (!preaggTable || !preaggOutputSelect || !preaggBinMeta || !preaggSourceChartMarkIds) {
			return null;
		}

		const { descriptor } = reg;
		const { parts, transformCompiler } = descriptor;

		// --- Compute bin filters from active brush extent ---
		const binFilters: ExprNode[] = [];
		for (const entry of reg.filterGroup.selection.items) {
			// Is this clause from the active source?
			let isActiveSource = false;
			for (const mid of entry.excludeMarkIds) {
				if (preaggSourceChartMarkIds.has(mid)) {
					isActiveSource = true;
					break;
				}
			}
			if (!isActiveSource) continue;
			if (entry.excludeMarkIds.has(markId)) continue;

			// Extract extent values and create bin filters
			const value = entry.value;
			if (preaggBinMeta.length === 1) {
				// Interval1D: value = [lo, hi]
				const [lo, hi] = value as [number, number];
				const { alias, d0, scaleFactor } = preaggBinMeta[0];
				const binLo = Math.floor((lo - d0) * scaleFactor);
				const binHi = Math.floor((hi - d0) * scaleFactor);
				binFilters.push(isBetween(column(alias), [literal(binLo), literal(binHi)]) as ExprNode);
			} else if (preaggBinMeta.length === 2) {
				// Interval2D: value = [[xLo, xHi], [yLo, yHi]]
				const extents = value as [[number, number], [number, number]];
				for (let i = 0; i < 2; i++) {
					const [lo, hi] = extents[i];
					const { alias, d0, scaleFactor } = preaggBinMeta[i];
					const binLo = Math.floor((lo - d0) * scaleFactor);
					const binHi = Math.floor((hi - d0) * scaleFactor);
					binFilters.push(isBetween(column(alias), [literal(binLo), literal(binHi)]) as ExprNode);
				}
			}
		}

		// --- Build selectDef: CAST recombined aggregates; dimensions are already
		// CAST in the preagg table; windowed channels are CAST by the outer CTE.
		const windowChannels = reg.preaggWindowChannels;
		const castSelect: Record<string, unknown> = {};
		const preaggGroupBy: ExprNode[] = [];
		for (const [ch, expr] of Object.entries(preaggOutputSelect)) {
			if (!isAggregateExpression(expr)) {
				castSelect[ch] = expr;
				preaggGroupBy.push(column(ch));
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
			hasWindowAggregates: false,
			hasSQLTransforms: parts.hasSQLTransforms,
			orderChannels: parts.orderChannels,
			aliasMap: parts.aliasMap,
			passthroughChannels: parts.passthroughChannels
		};

		return assembleQuery({
			table: preaggTable,
			parts: preaggParts,
			filter: binFilters,
			filterNulls: null, // preagg table already filtered
			transformCompiler,
			limit: params.limit,
			window: windowChannels ? { channels: windowChannels, cteName: '__preagg_cte' } : null
		}).toString();
	}

	/** Clear preagg state for a registration. Does NOT drop the table —
	 *  hash-named tables are reused via CREATE TABLE IF NOT EXISTS. */
	#dropPreagg(reg: MarkRegistration): void {
		reg.preaggTable = null;
		reg.preaggReady = false;
		reg.lastPreaggParts = null;
		reg.preaggOutputSelect = null;
		reg.preaggBinMeta = null;
		reg.preaggSourceChartMarkIds = null;
		reg.preaggWindowChannels = null;
	}

	/**
	 * Destroy the engine and close the connection.
	 */
	async destroy(): Promise<void> {
		this.#destroyed = true;
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

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) {
		if (!b.has(v)) return false;
	}
	return true;
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
