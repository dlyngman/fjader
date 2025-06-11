import { getContext } from 'svelte';
import { MosaicClient, Selection, queryFieldInfo, toDataColumns } from '@uwdata/mosaic-core';
import {
  Query,
  column as sqlColumn,
  desc as sqlDesc,
  asc as sqlAsc,
  isNode,
  isAggregateExpression,
  isNotNull,
  and
} from '@uwdata/mosaic-sql';


export class DataClient extends MosaicClient {

  data = $state(null);
  loading = $state(false);
  delayedLoading = $state(false); 
  #loadingTimeout = null;
  error = $state(null);
  config = $state({});

  arrowTable = $state(null);
  dataVersion = $state(0);

  _sourceTable = null;
  _fieldInfo = null;

  c = null;

  constructor(sourceTable, filterBy = null, options = {}) {
    super(filterBy); // Pass filterBy Selection up to MosaicClient

    const {
      filterNulls = null,
      dataFormat = 'array',  // 'array' | 'arrow' | 'both'
      ...restOptions
    } = options;

    this.clientName = options.name || `DataClient_${Math.random().toString(36).substring(2, 7)}`;
    this._sourceTable = sourceTable;

    this.config = {
      ...restOptions,
      _filterNulls: filterNulls,
      _dataFormat: dataFormat
    };

    try {
        this.c = getContext('chart');
    } catch (e) {
        this.c = null;
    }
  }

  setLoading(value) {
    if (value === this.loading) return;
    this.loading = value;
    
    if (value) {
      // Loading started - show spinner immediately, cancel any hide timeout
      if (this.#loadingTimeout) {
        clearTimeout(this.#loadingTimeout);
        this.#loadingTimeout = null;
      }
      this.delayedLoading = true; // Show immediately
      
    } else {
      // Loading stopped - hide spinner after delay to prevent flashing
      this.#loadingTimeout = setTimeout(() => {
        if (!this.loading) { // Make sure loading is still false
          this.delayedLoading = false;
        }
        this.#loadingTimeout = null;
      }, 300);
    }
  }

  /**
   * Updates one or more configuration options reactively.
   * Merges new options into the existing reactive `config` state.
   * @param {object} newOptions - An object containing config keys and values to update.
   */
  updateConfig(newOptions) {
    // Svelte's $state proxy will handle deep reactivity if the object structure changes.
    // If only properties are updated, it also works.
    this.config = { ...this.config, ...newOptions };
    // After config update, a query update is usually desired.
    // MosaicClient's connection to coordinator/selection handles this when filterBy changes.
    // For direct config changes, we might need to explicitly request an update if not tied to filterBy.
    if (this._initialized && !this.loading) {
        this.requestUpdate();
    }
  }

  /**
   * Fetches metadata (types, min/max extents for non-aggregates) for fields
   * defined in `this.config.select`. This runs once during initialization.
   * @override MosaicClient#prepare
   * @returns {Promise<void>}
   */
  async prepare() {
    const currentSourceTable = this._sourceTable;
    const selectConfig = this.config.select;

    if (!this.coordinator || !currentSourceTable || !selectConfig || Object.keys(selectConfig).length === 0) {
      this._fieldInfo = {};
      return;
    }

    const fieldRequests = [];
    const fieldsToQuery = new Map();

    for (const alias in selectConfig) {
      const expr = selectConfig[alias];
      const exprNode = isNode(expr) ? expr : sqlColumn(expr);
      const fieldKey = exprNode.toString();

      if (!fieldsToQuery.has(fieldKey)) {
        const isAggregate = isAggregateExpression(exprNode);
        fieldsToQuery.set(fieldKey, {
          column: exprNode,
          stats: new Set(isAggregate ? [] : ['min', 'max'])
        });
      }
    }

    fieldRequests.push(
      ...Array.from(fieldsToQuery.values(), entry => ({
        table: currentSourceTable,
        column: entry.column,
        stats: Array.from(entry.stats)
      }))
    );

    if (fieldRequests.length === 0) {
      this._fieldInfo = {};
      return;
    }

    const infoArray = await queryFieldInfo(this.coordinator, fieldRequests);
    
    this._fieldInfo = {};
    for (const info of infoArray) {
      let key = info.column;
      
      // Remove surrounding quotes if they exist
      if (typeof key === 'string') {
        key = key.replace(/^["']|["']$/g, ''); // Remove quotes from start/end
      }
      
      this._fieldInfo[key] = info;
    }
    
    this._setupScaleMapping();
    this._setInitialScales();
    this._setScalesReady();
  }

  /**
   * Constructs the SQL query based on the current reactive `config`.
   * @override MosaicClient#query
   * @param {Array} [filter=[]] - The filter predicate array from `filterBy` Selection.
   * @returns {Query | null} A mosaic-sql Query object or null if query cannot be formed.
   */
  query(filter = []) {
    if (!this._fieldInfo) {
        // console.warn(`${this.constructor.name}: Query called before prepare completed.`);
        return null;
    }
    if (!this._sourceTable) {
      this.error = new Error("Source table is not defined."); // Set error if forming query impossible
      // this.loading = false;
      this.setLoading(false); 
      return null;
    }

    const currentConfig = this.config;
    const selectDef = this._parseSelectDefinition(currentConfig.select);
    const { orderByExpressions } = this._parseSortAndLimit(currentConfig.sort);

    let limit = null;
    if (currentConfig.limit !== undefined) {
      limit = Number(currentConfig.limit);
      if (isNaN(limit) || limit <= 0) limit = null;
    }

    const q = Query.from(this._sourceTable);
    const nonAggregateGroupBy = [];
    let hasAggregates = false;

    for (const alias in selectDef) {
      const exprNode = selectDef[alias];
      if (isAggregateExpression(exprNode)) {
        hasAggregates = true;
      } else {
        nonAggregateGroupBy.push(exprNode);
      }
    }
    q.select(selectDef);

    if (hasAggregates && nonAggregateGroupBy.length > 0) {
      q.groupby(nonAggregateGroupBy);
    }
    if (orderByExpressions.length > 0) {
      q.orderby(orderByExpressions);
    }
    if (limit !== null) {
      q.limit(limit);
    }

    const allFilters = [...filter];
    
    if (currentConfig._filterNulls && Array.isArray(currentConfig._filterNulls)) {
      const nullFilters = currentConfig._filterNulls.map(col => isNotNull(col));
      allFilters.push(...nullFilters);
    }

    if (allFilters.length > 0) {
      q.where(and(allFilters));
    } else {
      q.where(filter); // Your original line
    }

    // q.where(filter);
    // console.log(`${this.clientName} built query: ${q.toString()}`);
    return q;
  }

  /**
   * Parses the `select` part of the config into SQL AST nodes.
   * @param {object} selectOpts - The `select` configuration object.
   * @returns {object} - A map of alias to SQL AST Node.
   * @protected
   */
  _parseSelectDefinition(selectOpts) {
    const def = {};
    if (!selectOpts || typeof selectOpts !== 'object') return def;
    for (const alias in selectOpts) {
      const exprInput = selectOpts[alias];
      if (typeof exprInput === 'string') {
        def[alias] = sqlColumn(exprInput);
      } else if (isNode(exprInput)) {
        def[alias] = exprInput;
      }
    }
    return def;
  }

  /**
   * Parses the `sort` part of the config into SQL order expressions and limit.
   * @param {object} sortOptions - The `sort` configuration object { by, direction?, limit? }.
   * @returns {{orderByExpressions: Array<object>, limit: number | null}}
   * @protected
   */
  _parseSortAndLimit(sortOptions) {
    const orderByExpressions = [];
    if (!sortOptions || typeof sortOptions !== 'object') return { orderByExpressions };

    const by = sortOptions.by;
    const direction = sortOptions.direction;

    if (by) {
      let sortAlias = by;
      let sortFn = sqlAsc;
      if (by.startsWith('-')) { sortAlias = by.substring(1); sortFn = sqlDesc; }
      else if (by.startsWith('+')) { sortAlias = by.substring(1); }
      else if (direction && String(direction).toUpperCase() === 'DESC') { sortFn = sqlDesc; }
      orderByExpressions.push(sortFn(sortAlias)); // Use alias directly
    }
    return { orderByExpressions };
  }

  /**
   * Called by the coordinator to inform the client that a query is pending.
   * Sets the loading state to true.
   * @override MosaicClient#queryPending
   * @returns {this}
   */
  queryPending() {
    // this.loading = true;
    this.setLoading(true); 
    this.error = null;
    return this;
  }

  /**
   * Processes the raw query result.
   * @override MosaicClient#queryResult
   * @param {*} rawData - The raw data from the coordinator.
   */
  queryResult(rawData) {
    const dataFormat = this.config._dataFormat || 'array';

    try {
      if (dataFormat === 'arrow' || dataFormat === 'both') {
        this.arrowTable = rawData;
        this.dataVersion++;
      }

      if (dataFormat === 'array' || dataFormat === 'both') {
        const formattedData = this._formatData(rawData);
        this.data = this._processData(formattedData); // Subclasses can override _processData
        this._updateScales(this.data); // Subclasses can override _updateScales
      } else {
      }

      this.error = null;
    } catch (err) {
      this.queryError(err);
    } finally {
      // this.loading = false;
      this.setLoading(false); 
    }
    return this;
  }

  /**
   * Handles errors during the query execution.
   * @override MosaicClient#queryError
   * @param {Error} error - The error object.
   */
  queryError(error) {
    console.error(`${this.clientName}: Query Error -`, error);
    this.error = error;
    // this.loading = false;
    this.setLoading(false); 
    this.data = null;
    return this;
  }

  /**
   * Converts raw data (typically Arrow Table) to a JS array of objects.
   * Subclasses can override if a different initial format is needed.
   * @param {*} rawData - Raw data from the coordinator.
   * @returns {Array<object> | null} Formatted data or null.
   * @protected
   */
  _formatData(rawData) {
    if (!rawData) return null;
    if (typeof rawData.toArray === 'function') return Array.from(rawData);
    if (Array.isArray(rawData)) return rawData;
    console.warn(`${this.clientName}: Unexpected raw data format in _formatData.`);
    return rawData;
  }

  /**
   * Further processes formatted data. Base implementation is a pass-through.
   * Subclasses override this for specific data transformations (e.g., Top N + Other).
   * @param {Array<object> | null} formattedData - Data after initial formatting.
   * @returns {Array<object> | null} Processed data.
   * @protected
   */
  _processData(formattedData) {
    return formattedData;
  }

  _setupScaleMapping() {
    if (!this.c) {
      console.log('❌ No chart context - returning early');
      return;
    }
    
    const selectConfig = this.config.select;
    
    if (!selectConfig) {
      console.log('❌ No selectConfig - returning early');
      return;
    }

    this._scaleMap = {};

    for (const alias in selectConfig) {      
      // Check x condition step by step
      if (alias === 'x') {
        if (this.c.xScaleState) {
          this._scaleMap.x = this.c.xScaleState;
        } else {
        }
      } else if (alias === 'y') {
        if (this.c.yScaleState) {
          this._scaleMap.y = this.c.yScaleState;
        } else {
        }
      } else {
      }
    }

  }

  _setInitialScales() {
    if (!this._scaleMap || !this._fieldInfo) return;
  
    const selectConfig = this.config.select;
    
    for (const alias in selectConfig) {
      const scale = this._scaleMap[alias];
      if (!scale) continue;
      
      // Get the column name directly from the select config
      const columnName = selectConfig[alias]; // "flipper_length", "bill_depth", etc.
      
      // Look up field info using the column name
      const fieldInfo = this._fieldInfo[columnName];
      
      if (fieldInfo && fieldInfo.min != null && fieldInfo.max != null) {
        scale.addMark([fieldInfo.min, fieldInfo.max], this.clientName);
      } else {
      }
    }
  }

  _setScalesReady() {
    if (!this._scaleMap) return;
    
    Object.values(this._scaleMap).forEach(scale => {
      if (scale.setReady) {
        scale.setReady();
      }
    });    
  }


  // _setInitialScales() {
  //   if (!this._scaleMap) return;
  
  //   const selectConfig = this.config.select;
    
  //   for (const alias in selectConfig) {
  //     const scale = this._scaleMap[alias];
  //     if (!scale) continue;
      
  //     const fieldInfo = this.getFieldInfo(alias);
  //     console.log(fieldInfo, alias)
  //     if (fieldInfo && fieldInfo.min != null && fieldInfo.max != null) {
  //       scale.addMark([fieldInfo.min, fieldInfo.max], this.clientName);
  //     }
  //   }
  // }

  _updateScales(processedData) {
    // ✅ FAST: Early exit if no scales or data
    if (!this._scaleMap || !processedData || processedData.length === 0) {
      return;
    }
  
    // ✅ SIMPLE: Just update each mapped scale directly
    if (this._scaleMap.x) {
      const xValues = processedData.map(d => d.x).filter(v => v != null);
      if (xValues.length > 0) {
        this._scaleMap.x.addMark(xValues, this.clientName);
      }
    }
  
    if (this._scaleMap.y) {
      const yValues = processedData.map(d => d.y).filter(v => v != null);
      if (yValues.length > 0) {
        this._scaleMap.y.addMark(yValues, this.clientName);
      }
    }
  
    // Add more scales as needed:
    // if (this._scaleMap.color) {
    //   const colorValues = [...new Set(processedData.map(d => d.color).filter(v => v != null))];
    //   if (colorValues.length > 0) {
    //     this._scaleMap.color.addMark(colorValues, this.clientName);
    //   }
    // }
  }



  // /**
  //  * Updates chart scales based on the processed data.
  //  * Base implementation attempts to update scales based on `this.config.select`.
  //  * Subclasses should override for specific scale update logic.
  //  * @param {Array<object> | null} processedData - The final data to be used for scales.
  //  * @protected
  //  */
  // _updateScales(processedData) {
  //   if (!this.c) { // 'c' is the chart context
  //     // console.warn(`${this.clientName}: Chart context not found. Scale updates might be skipped.`);
  //     return;
  //   }

  //   const selectConfig = this.config.select;

  //   // Determine which scales were previously managed by this client to clear them if no data
  //   const previouslyManagedAliases = this._managedScaleAliases || new Set();
  //   const currentManagedAliases = new Set();

  //   if (!processedData || processedData.length === 0 || !selectConfig || typeof selectConfig !== 'object') {
  //       // Clear scales for previously managed aliases
  //       previouslyManagedAliases.forEach(alias => {
  //           if (alias === 'x' && this.c.xScaleState) this.c.xScaleState.removeMark(this.clientId);
  //           else if (alias === 'y' && this.c.yScaleState) this.c.yScaleState.removeMark(this.clientId);
  //           // Add logic for other scale types (color, size, etc.) if they exist in this.c
  //           // else if (alias === 'color' && this.c.colorScaleState) this.c.colorScaleState.removeMark(this.clientId);
  //       });
  //       this._managedScaleAliases = new Set(); // Reset managed aliases
  //       return;
  //   }

  //   for (const alias in selectConfig) {
  //     if (Object.prototype.hasOwnProperty.call(selectConfig, alias)) {
  //       currentManagedAliases.add(alias);
  //       const values = processedData.map(d => d[alias]);
  //       // const vector = denseVector(values); // Optional: if scales expect Flechette vectors

  //       if (alias === 'x' && this.c.xScaleState) {
  //         this.c.xScaleState.addMark(values, this.clientId); // or vector
  //       } else if (alias === 'y' && this.c.yScaleState) {
  //         this.c.yScaleState.addMark(values, this.clientId); // or vector
  //       }
  //       // Example for a color scale
  //       // else if (alias === 'color' && this.c.colorScaleState) {
  //       //   this.c.colorScaleState.addMark(values, this.clientId);
  //       // }
  //       // Add more scale types as needed
  //     }
  //   }

  //   // Clear scales for any aliases that were previously managed but are no longer selected
  //   previouslyManagedAliases.forEach(alias => {
  //       if (!currentManagedAliases.has(alias)) {
  //           if (alias === 'x' && this.c.xScaleState) this.c.xScaleState.removeMark(this.clientId);
  //           else if (alias === 'y' && this.c.yScaleState) this.c.yScaleState.removeMark(this.clientId);
  //           // else if (alias === 'color' && this.c.colorScaleState) this.c.colorScaleState.removeMark(this.clientId);
  //       }
  //   });
  //   this._managedScaleAliases = currentManagedAliases; // Store current managed aliases
  // }

  /**
   * Cleans up the client, disconnecting from the coordinator.
   */
  destroy() {
    if (this.#loadingTimeout) {
      clearTimeout(this.#loadingTimeout);
      this.#loadingTimeout = null;
    }

    if (this.coordinator) {
      this.coordinator.disconnect(this);
    }

    if (this._scaleMap) {
      Object.values(this._scaleMap).forEach(scale => {
        scale.removeMark(this.clientName);
      });
      this._scaleMap = null;
    }
    // // Clear scales managed by this client
    // if (this.c && this._managedScaleAliases) {
    //     this._managedScaleAliases.forEach(alias => {
    //         if (alias === 'x' && this.c.xScaleState) this.c.xScaleState.removeMark(this.clientId);
    //         else if (alias === 'y' && this.c.yScaleState) this.c.yScaleState.removeMark(this.clientId);
    //         // else if (alias === 'color' && this.c.colorScaleState) this.c.colorScaleState.removeMark(this.clientId);
    //     });
    // }
    // console.log(`${this.clientName} destroyed.`);
  }
}