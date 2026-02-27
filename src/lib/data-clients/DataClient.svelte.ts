import { MosaicClient, queryFieldInfo } from '@uwdata/mosaic-core';
import type { FieldInfoRequest } from '@uwdata/mosaic-core';
import type { Selection } from '@uwdata/mosaic-core';
import {
	Query,
	column as sqlColumn,
	isNode,
	isAggregateExpression,
	isNotNull,
	and
} from '@uwdata/mosaic-sql';
import type { ExprNode, FilterExpr, ExprValue, SelectExpr, GroupByExpr, OrderByExpr } from '@uwdata/mosaic-sql';
import type { Table } from '@uwdata/flechette';

type DataFormat = 'arrow' | 'array' | 'both';

export type QueryBuilder = (
	sourceTable: string,
	config: DataClientConfig,
	filter: FilterExpr
) => Query | null;

export interface DataClientOptions {
	name?: string;
	filterNulls?: ExprValue[] | null;
	dataFormat?: DataFormat;
	queryBuilder?: QueryBuilder;
	filterStable?: boolean;
	[key: string]: unknown;
}

export interface DataClientConfig {
	_filterNulls: ExprValue[] | null;
	_dataFormat: DataFormat;
	select?: Record<string, unknown>;
	sort?: { channel: string; direction: 'asc' | 'desc' } | null;
	limit?: number;
	[key: string]: unknown;
}

export interface FieldInfoEntry {
	column: string;
	[key: string]: unknown;
}

/**
 * A generic, stateful bridge to the Mosaic data backend.
 * Its primary responsibility is to execute queries and manage the resulting state
 * (data, loading, errors). It is designed to be a reusable service, completely
 * decoupled from any view or chart-specific logic.
 */
export class DataClient extends MosaicClient {
	// --- Reactive State Properties (for Svelte components to bind to) ---
	data = $state<unknown[] | null>(null);
	arrowTable = $state<Table | null>(null);
	fieldInfo = $state<Record<string, FieldInfoEntry> | null>(null);
	loading = $state(false);
	delayedLoading = $state(false);
	error = $state<Error | unknown | null>(null);
	dataVersion = $state(0);
	config = $state<DataClientConfig>({ _filterNulls: null, _dataFormat: 'arrow' });

	clientName: string;
	_sourceTable: string;

	// --- Private Internal Properties ---
	#loadingTimeout: ReturnType<typeof setTimeout> | null = null;
	#fieldRequests: FieldInfoRequest[];
	#queryBuilder: QueryBuilder;
	#filterStable: boolean;

	constructor(
		sourceTable: string,
		filterBy: Selection | null = null,
		options: DataClientOptions = {},
		fieldRequests: FieldInfoRequest[] = []
	) {
		super(filterBy);

		const {
			filterNulls = null,
			dataFormat = 'arrow' as DataFormat,
			queryBuilder = this._defaultQueryBuilder,
			filterStable = true,
			...restOptions
		} = options;

		this.clientName = options.name || `DataClient_${crypto.randomUUID().slice(0, 8)}`;
		this._sourceTable = sourceTable;
		this.#fieldRequests = fieldRequests;
		this.#queryBuilder = queryBuilder;
		this.#filterStable = filterStable;

		this.config = {
			...restOptions,
			_filterNulls: filterNulls,
			_dataFormat: dataFormat
		};
	}

	/**
	 * Override MosaicClient.filterStable. When false, Mosaic's PreAggregator
	 * skips this client (preaggColumns returns null immediately).
	 * Window expressions are incompatible with Mosaic's preagg because
	 * collectAggregates walks into WINDOW nodes and finds the inner aggregate,
	 * but preaggregateInfo doesn't add the dimension columns to GROUP BY,
	 * causing the CREATE TABLE to fail silently.
	 */
	override get filterStable(): boolean {
		return this.#filterStable;
	}

	// =================================================================
	// ==  MOSAIC CLIENT LIFECYCLE METHODS                            ==
	// =================================================================

	async prepare(): Promise<void> {
		console.log('DataClient: initializing');
		if (!this.coordinator || this.#fieldRequests.length === 0) {
			this.fieldInfo = {};
			return;
		}

		try {
			const infoArray = await queryFieldInfo(this.coordinator, this.#fieldRequests);
			const infoMap: Record<string, FieldInfoEntry> = {};
			for (const info of infoArray as unknown as FieldInfoEntry[]) {
				const key = info.column.replace(/^["']|["']$/g, '');
				infoMap[key] = info;
			}
			this.fieldInfo = infoMap;
		} catch (err) {
			console.error(`[${this.clientName}] Error fetching field info:`, err);
			this.fieldInfo = {};
			this.queryError(err);
		}
	}

	query(filter?: FilterExpr | null): Query | null {
		if (!this._sourceTable) {
			this.error = new Error('Source table is not defined.');
			this.setLoading(false);
			return null;
		}
		return this.#queryBuilder(this._sourceTable, this.config, filter ?? []);
	}

	queryPending(): this {
		this.setLoading(true);
		this.error = null;
		return this;
	}

	queryResult(rawData: unknown): this {
		const dataFormat = this.config._dataFormat;
		try {
			if (dataFormat === 'arrow' || dataFormat === 'both') {
				this.arrowTable = rawData as Table;
				this.dataVersion++; // Increment version for reactive consumers
			}
			if (dataFormat === 'array' || dataFormat === 'both') {
				this.data = Array.isArray(rawData) ? rawData : Array.from(rawData as Iterable<unknown>);
			}
			this.error = null;
		} catch (err) {
			this.queryError(err);
		} finally {
			this.setLoading(false);
		}
		return this;
	}

	queryError(error: unknown): this {
		console.error(`[${this.clientName}] Query Error:`, error);
		this.error = error;
		this.setLoading(false);
		this.data = null;
		this.arrowTable = null;
		return this;
	}

	// =================================================================
	// ==  DEFAULT QUERY BUILDER                                      ==
	// =================================================================

	_defaultQueryBuilder(sourceTable: string, config: DataClientConfig, filter: FilterExpr): Query {
		const { select, sort, limit, _filterNulls } = config;

		const q = Query.from(sourceTable);
		const selectDef: Record<string, ExprValue> = {};
		const nonAggregateGroupBy: ExprNode[] = [];
		let hasAggregates = false;

		// 1. Parse select expressions and identify aggregates vs. dimensions
		for (const alias in select) {
			const expr = select[alias];
			if (expr == null) continue; // Skip null/undefined expressions

			const exprNode = isNode(expr) ? expr : sqlColumn(String(expr));
			selectDef[alias] = exprNode;

			if (isAggregateExpression(exprNode)) {
				hasAggregates = true;
			} else {
				nonAggregateGroupBy.push(exprNode);
			}
		}
		q.select(selectDef);

		// 2. Add GROUP BY clause ONLY if there are aggregates and dimensions
		if (hasAggregates && nonAggregateGroupBy.length > 0) {
			q.groupby(...nonAggregateGroupBy);
		}

		// 3. Add filtering
		const allFilters: (string | boolean | ExprNode)[] = [...(Array.isArray(filter) ? filter : filter ? [filter] : [])];
		if (_filterNulls && Array.isArray(_filterNulls)) {
			allFilters.push(..._filterNulls.map((col) => isNotNull(col as ExprValue)));
		}
		if (allFilters.length > 0) {
			q.where(and(...allFilters));
		}

		// 4. Add sorting and limit
		if (sort) {
			const dir = sort.direction === 'desc' ? 'DESC' : 'ASC';
			q.orderby({ [sort.channel]: dir } as unknown as OrderByExpr);
		}
		if (limit) q.limit(limit);

		return q;
	}

	// =================================================================
	// ==  UTILITY AND CLEANUP METHODS                                ==
	// =================================================================

	setLoading(value: boolean): void {
		if (value === this.loading) return;
		this.loading = value;

		if (this.#loadingTimeout) clearTimeout(this.#loadingTimeout);

		if (value) {
			this.delayedLoading = true;
		} else {
			// Hide spinner after a short delay to prevent flashing on fast queries
			this.#loadingTimeout = setTimeout(() => {
				if (!this.loading) this.delayedLoading = false;
			}, 300);
		}
	}

	destroy(): void {
		if (this.#loadingTimeout) clearTimeout(this.#loadingTimeout);
		if (this.coordinator) this.coordinator.disconnect(this);
	}
}
