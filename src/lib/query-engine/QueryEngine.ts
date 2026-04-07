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

import type { Table } from '@uwdata/flechette';
import {
	isNode,
	isColumnRef,
	isAggregateExpression,
	coalesce,
	cast,
	sql as sqlTag
} from '@uwdata/mosaic-sql';
import { isWindowExpression } from '$lib/sql/expression-utils';
import { assembleQuery, type QueryParts } from '$lib/components/marks/lifecycle/query-builder';
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
}

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
 * Minimal connection interface matching DuckDB-WASM's AsyncDuckDBConnection.
 * Allows testing with a mock connection.
 */
export interface DuckDBConnection {
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
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export class QueryEngine {
	#conn: DuckDBConnection | null = null;
	#connPromise: Promise<DuckDBConnection> | null = null;
	#inflight = new Map<string, AbortController>();
	#pending = new Map<string, { sql: string; resolve: (t: Table) => void; reject: (e: Error) => void }>();
	#describeCache = new Map<string, Promise<ColumnInfo[]>>();
	#marks = new Map<string, MarkRegistration>();
	#destroyed = false;

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
			const result = await this.#conn!.query(sqlStr);
			if (opts.signal.aborted) {
				throw new DOMException('Query aborted', 'AbortError');
			}
			return result;
		}

		return this.#conn!.query(sqlStr);
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

			const result = await this.#conn!.query(sqlStr);

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
		const result = await this.#conn!.query(`DESCRIBE "${escaped}"`);
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
			lastPreaggParts: null
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
			const filter = selection.predicate(markId);
			const { descriptor, handle } = reg;

			// Preagg routing: use preagg table if available and parts haven't changed.
			// Reference equality — $derived memoization ensures same object when
			// dependencies don't change.
			const usePreagg =
				reg.preaggReady &&
				reg.preaggTable &&
				descriptor.parts === reg.lastPreaggParts;
			const sourceTable = usePreagg ? reg.preaggTable! : descriptor.table;

			const sqlStr = this.#assembleSQL(descriptor, sourceTable, filter, handle.params);
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
		const filter = reg.filterGroup.selection.predicate(markId);
		const { descriptor, handle } = reg;

		const usePreagg =
			reg.preaggReady &&
			reg.preaggTable &&
			descriptor.parts === reg.lastPreaggParts;
		const sourceTable = usePreagg ? reg.preaggTable! : descriptor.table;

		const sqlStr = this.#assembleSQL(descriptor, sourceTable, filter, handle.params);
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

		// CAST wrapping: COALESCE(CAST(... AS REAL), 'NaN'::REAL) on numeric channels.
		// Ensures DuckDB returns Float32Array (zero-copy in DataAccessor).
		// COALESCE converts SQL NULL to NaN float, giving nullCount=0 Arrow buffers.
		const castSelectDef = { ...selectDef };

		for (const [ch, expr] of Object.entries(castSelectDef)) {
			if (expr == null) continue;

			// Aggregates and window functions always produce numeric output
			if (isAggregateExpression(expr as any) || isWindowExpression(expr as any)) {
				castSelectDef[ch] = coalesce(cast(expr, 'REAL'), sqlTag`'NaN'::REAL`);
				continue;
			}

			// Non-column SQL nodes (CASE expressions from scale inlining) are numeric
			if (isNode(expr) && !isColumnRef(expr as any)) {
				castSelectDef[ch] = coalesce(cast(expr, 'REAL'), sqlTag`'NaN'::REAL`);
				continue;
			}

			// Column references: check source column type from schema
			if (isColumnRef(expr as any)) {
				const colName = (expr as any).column as string;
				const jsType = schema?.get(colName)?.jsType;
				if (jsType === 'number') {
					castSelectDef[ch] = coalesce(cast(expr, 'REAL'), sqlTag`'NaN'::REAL`);
				}
			}
		}

		const castParts = { ...parts, selectDef: castSelectDef };
		const q = assembleQuery(
			sourceTable,
			castParts,
			filter,
			params.filterNulls ?? null,
			transformCompiler,
			false, // forMosaic — always false in v2/v3 (channel names throughout)
			undefined
		);

		if (params.limit) {
			q.limit(params.limit);
		}

		return q?.toString() ?? null;
	}

	/**
	 * Pre-aggregate marks for a filter group before brushing begins.
	 * Called by interactors on pointerenter — before the first brush drag.
	 *
	 * TODO: Implement Mosaic-style data cube pre-aggregation. The cube would
	 * include filter dimensions in GROUP BY so brushing queries re-aggregate
	 * from the cube (hundreds of rows) instead of the raw table (millions).
	 * Requires knowing filter dimensions upfront and rewriting the brush
	 * query to SUM pre-computed counts. For now, this is a no-op — marks
	 * query the base table directly during brushing.
	 */
	async activate(
		_filterGroup: FilterGroup,
		_sourceChartMarkIds: Set<string>
	): Promise<void> {
		// No-op until data cube preagg is implemented.
	}

	#dropPreagg(reg: MarkRegistration): void {
		if (reg.preaggTable) {
			this.exec(`DROP TABLE IF EXISTS "${reg.preaggTable}"`).catch(() => {});
			reg.preaggTable = null;
			reg.preaggReady = false;
			reg.lastPreaggParts = null;
		}
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
