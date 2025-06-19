import { MosaicClient, queryFieldInfo, toDataColumns } from '@uwdata/mosaic-core';
import {
  Query,
  column as sqlColumn,
  isNode,
  isAggregateExpression,
  isNotNull,
  and
} from '@uwdata/mosaic-sql';

/**
 * A generic, stateful bridge to the Mosaic data backend.
 * Its primary responsibility is to execute queries and manage the resulting state
 * (data, loading, errors). It is designed to be a reusable service, completely
 * decoupled from any view or chart-specific logic.
 *
 * It is configured by a "controller" (like a MarkSetup class), which tells it
 * what metadata to prepare and how to build its queries.
 */
export class DataClient extends MosaicClient {
  // --- Reactive State Properties (for Svelte components to bind to) ---
  data = $state(null);
  arrowTable = $state(null);
  fieldInfo = $state(null);
  loading = $state(false);
  delayedLoading = $state(false);
  error = $state(null);
  dataVersion = $state(0);
  config = $state({});

  // --- Private Internal Properties ---
  #loadingTimeout = null;
  #fieldRequests;
  #queryBuilder;

  /**
   * Creates an instance of DataClient.
   * @param {string} sourceTable The database table to query.
   * @param {import('@uwdata/mosaic-core').Selection} [filterBy=null] An optional Mosaic Selection for filtering.
   * @param {object} [options={}] Configuration for the client.
   * @param {Function} [options.queryBuilder] A function that builds the SQL query. If not provided, a default builder is used.
   * @param {Array} [fieldRequests=[]] The specific metadata requests for the prepare() step.
   */
  constructor(sourceTable, filterBy = null, options = {}, fieldRequests = []) {
    super(filterBy);

    const {
      filterNulls = null,
      dataFormat = 'arrow',
      queryBuilder = this._defaultQueryBuilder,
      ...restOptions
    } = options;

    this.clientName = options.name || `DataClient_${crypto.randomUUID().slice(0, 8)}`;
    this._sourceTable = sourceTable;
    this.#fieldRequests = fieldRequests;
    this.#queryBuilder = queryBuilder;

    this.config = {
      ...restOptions,
      _filterNulls: filterNulls,
      _dataFormat: dataFormat
    };
  }

  // =================================================================
  // ==  MOSAIC CLIENT LIFECYCLE METHODS                            ==
  // =================================================================

  /**
   * Fetches metadata based on requests provided during construction.
   * This is an internal lifecycle hook called by the Coordinator upon connection.
   * @override
   */
  async prepare() {
    console.log('DataClient: initializing')
    if (!this.coordinator || this.#fieldRequests.length === 0) {
      this.fieldInfo = {};
      return;
    }

    try {
      const infoArray = await queryFieldInfo(this.coordinator, this.#fieldRequests);
      const infoMap = {};
      for (const info of infoArray) {
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

  /**
   * Builds the main data query by delegating to its assigned query builder.
   * This is an internal lifecycle hook called by the Coordinator.
   * @override
   * @param {Array} [filter=[]] - The filter predicate from `filterBy` Selection.
   * @returns {Query | null}
   */
  query(filter = []) {
    if (!this._sourceTable) {
      this.error = new Error("Source table is not defined.");
      this.setLoading(false);
      return null;
    }
    return this.#queryBuilder(this._sourceTable, this.config, filter);
  }

  /**
   * Called by the coordinator when a query is dispatched.
   * @override
   */
  queryPending() {
    this.setLoading(true);
    this.error = null;
    return this;
  }

  /**
   * Called by the coordinator with the result of a query.
   * @override
   */
  queryResult(rawData) {
    const dataFormat = this.config._dataFormat;
    try {
      if (dataFormat === 'arrow' || dataFormat === 'both') {
        this.arrowTable = rawData;
        this.dataVersion++; // Increment version for reactive consumers
      }
      if (dataFormat === 'array' || dataFormat === 'both') {
        this.data = Array.isArray(rawData) ? rawData : Array.from(rawData);
      }
      this.error = null;
    } catch (err) {
      this.queryError(err);
    } finally {
      this.setLoading(false);
    }
    return this;
  }

  /**
   * Called by the coordinator when a query fails.
   * @override
   */
  queryError(error) {
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

  /**
   * The default query builder. It correctly handles SQL expressions,
   * aggregations, and automatic GROUP BY clause generation.
   * This is used when a mark does not provide its own specialized builder.
   */
  _defaultQueryBuilder(sourceTable, config, filter) {
    const { select, sort, limit, _filterNulls } = config;

    const q = Query.from(sourceTable);
    const selectDef = {};
    const nonAggregateGroupBy = [];
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
      q.groupby(nonAggregateGroupBy);
    }

    // 3. Add filtering
    const allFilters = [...filter];
    if (_filterNulls && Array.isArray(_filterNulls)) {
      allFilters.push(..._filterNulls.map(col => isNotNull(col)));
    }
    if (allFilters.length > 0) {
      q.where(and(allFilters));
    }

    // 4. Add sorting and limit
    if (sort) {
      const dir = sort.direction === 'desc' ? 'DESC' : 'ASC';
      q.orderby({ [sort.by]: dir });
    }
    if (limit) q.limit(limit);

    return q;
  }
  
  // =================================================================
  // ==  UTILITY AND CLEANUP METHODS                                ==
  // =================================================================

  setLoading(value) {
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

  destroy() {
    if (this.#loadingTimeout) clearTimeout(this.#loadingTimeout);
    if (this.coordinator) this.coordinator.disconnect(this);
  }
}