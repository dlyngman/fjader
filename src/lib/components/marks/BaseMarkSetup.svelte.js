// src/lib/components/marks/BaseMarkSetup.svelte.js
import { untrack } from 'svelte';
import { DataClient } from '$lib/data-clients/DataClient.svelte.js';
import { Query, isNode, column as sqlColumn, isAggregateExpression, isNotNull, and } from '@uwdata/mosaic-sql';
import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities.js';

/**
 * A generic controller that handles the common lifecycle, state management,
 * and data fetching orchestration for a mark component using reactive patterns.
 * This class acts as the "ViewModel" or "Controller" for a mark.
 */
export class BaseMarkSetup {
  // --- Reactive State (for the View to consume) ---
  client = $state(null);
  categoricalDataFetched = $state(false);

  // --- Reactive Setup Progress State ---
  #scaleStatesReady = $state(false);
  #scaleMappingsReady = $state(false);
  #clientCreated = $state(false);
  #clientDataReady = $state(false);
  #continuousDomainsSet = $state(false);
  #categoricalFetchStarted = $state(false);

  // --- Private Properties ---
  #config;
  #coordinator;
  #chartContext;
  #markId;
  #scaleMap = {};

  /**
   * @param {object} config The mark's configuration object, derived from Svelte props.
   * @param {import('@uwdata/mosaic-core').Coordinator} coordinator The Mosaic coordinator instance.
   * @param {object} chartContext The chart's context object.
   */
  constructor(config, coordinator, chartContext, stableId = null) {
    this.#config = config;
    this.#coordinator = coordinator;
    this.#chartContext = chartContext;
    this.#markId =  stableId || `${config.markType}-${crypto.randomUUID().slice(0, 8)}`;
    this.#registerScaleRequirements();
    this.#setupReactiveEffects();
  }

  #setupReactiveEffects() {

    // Effect 1: Wait for scale objects to be available in context
    $effect(() => {
      const { scaleTypes, xScaleState, yScaleState } = this.#chartContext;
      if (!!(scaleTypes && xScaleState && yScaleState) && !this.#scaleStatesReady) {
        this.#scaleStatesReady = true;
      }
    });

    // Effect 2: Setup scale mappings when scale states are ready
    $effect(() => {
      if (this.#scaleStatesReady && !this.#scaleMappingsReady) {
        this.#setupScaleMappings();
        this.#scaleMappingsReady = true;
      }
    });

    // Effect 3: Create client when scale mappings are ready
    $effect(() => {
      if (this.#scaleMappingsReady && !this.#clientCreated) {
        const fieldRequests = this.#buildFieldInfoRequests();
        this.#createClient(fieldRequests);
        this.#clientCreated = true;
      }
    });

    // Effect 4: Monitor client data readiness
    $effect(() => {
      if (this.#clientCreated && this.client?.fieldInfo && !this.#clientDataReady) {
        this.#clientDataReady = true;
      }
    });

    // Effect 5: Set initial continuous domains when client data is ready
    $effect(() => {
      if (this.#clientDataReady && !this.#continuousDomainsSet) {
        this.#setInitialContinuousDomains(this.client.fieldInfo);
        this.#continuousDomainsSet = true;
      }
    });

    // Effect 6: Start categorical domain fetch when continuous domains are set
    $effect(() => {
      if (this.#continuousDomainsSet && !this.#categoricalFetchStarted) {
        this.#categoricalFetchStarted = true;
        
        // Trigger async operation without awaiting in effect
        this.#fetchCategoricalDomains().then(() => {
          this.categoricalDataFetched = true;
          this.#setScalesReady();
          console.log(`✅ Mark ${this.#markId} setup complete`);
        }).catch(error => {
          console.error(`❌ Categorical domain fetch failed for ${this.#markId}:`, error);
        });
      }
    });
  }

  /**
   * Register scale requirements with the chart context
   * This happens immediately in the constructor to ensure proper timing
   */
  #registerScaleRequirements() {
    const { scaleRequirements } = this.#config;
    
    if (scaleRequirements?.x) {
      this.#chartContext.registerScaleType(
        'x', 
        scaleRequirements.x.type, 
        scaleRequirements.x.priority, 
        this.#markId
      );
    }
    
    if (scaleRequirements?.y) {
      this.#chartContext.registerScaleType(
        'y', 
        scaleRequirements.y.type, 
        scaleRequirements.y.priority, 
        this.#markId
      );
    }
  }

  get actualXScaleType() {
    return this.#chartContext.scaleTypes?.x || 'linear';
  }

  get actualYScaleType() {
    return this.#chartContext.scaleTypes?.y || 'linear';
  }

  get markId() {
    return this.#markId;
  }

  scaleCompatibilityError = $derived.by(() => {
    const { supportedScaleTypes, markType } = this.#config;
    if (!this.actualXScaleType || !this.actualYScaleType) return null;

    const incompatibleX = !supportedScaleTypes.x.includes(this.actualXScaleType);
    const incompatibleY = !supportedScaleTypes.y.includes(this.actualYScaleType);

    if (incompatibleX) return `${markType} cannot use scale type '${this.actualXScaleType}' for the x-axis.`;
    if (incompatibleY) return `${markType} cannot use scale type '${this.actualYScaleType}' for the y-axis.`;

    return null;
  });

  gpuReady = $derived.by(() => {
    if (!this.#chartContext.scalesReady || !this.categoricalDataFetched) return false;

    const xReady = (this.actualXScaleType === 'band' || this.actualXScaleType === 'point') 
      ? this.#chartContext.xScaleState?.isReadyForGPU 
      : this.#chartContext.xScaleState?.ready;
      
    const yReady = (this.actualYScaleType === 'band' || this.actualYScaleType === 'point')
      ? this.#chartContext.yScaleState?.isReadyForGPU 
      : this.#chartContext.yScaleState?.ready;
      
    return xReady && yReady;
  });

  /**
   * Cleans up all resources used by this mark controller.
   */
  destroy() {
    // Unregister scale requirements
    this.#chartContext.unregisterScaleType('x', this.#markId);
    this.#chartContext.unregisterScaleType('y', this.#markId);
    
    // Remove from scale states
    Object.values(this.#scaleMap).forEach(scale => scale?.removeMark?.(this.#markId));

    // Destroy data client
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  /**
   * @virtual
   * Returns the `select` configuration object for the DataClient.
   */
  getSelectConfig() {
    return this.#config.select || {};
  }

  /**
   * @virtual
   * Builds the SQL query for the DataClient.
   */
  buildQuery(sourceTable, config, filter) {
    const { select, sort, limit, _filterNulls } = config;

    const q = Query.from(sourceTable);
    const selectDef = {};
    const nonAggregateGroupBy = [];
    let hasAggregates = false;

    for (const alias in select) {
      const expr = select[alias];
      if (expr == null) continue;

      const exprNode = isNode(expr) ? expr : sqlColumn(String(expr));
      selectDef[alias] = exprNode;

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

    const allFilters = [...filter];
    if (_filterNulls && Array.isArray(_filterNulls)) {
      allFilters.push(..._filterNulls.map(col => isNotNull(col)));
    }
    if (allFilters.length > 0) {
      q.where(and(allFilters));
    }
    
    if (sort) q.orderby({ [sort.by]: sort.direction === 'desc' ? 'DESC' : 'ASC' });
    if (limit) q.limit(limit);

    return q;
  }

  #createClient(fieldRequests) {
    if (this.client) this.client.destroy();
    
    this.client = new DataClient(
      this.#config.table,
      this.#config.selection,
      {
        select: this.getSelectConfig(),
        queryBuilder: (table, config, filter) => this.buildQuery(table, config, filter),
        dataFormat: 'arrow',
        name: this.#markId,
        ...this.#config.clientOptions
      },
      fieldRequests
    );
    this.#coordinator.connect(this.client);
  }

  #setupScaleMappings() {
    this.#scaleMap = {
      x: this.#chartContext.xScaleState,
      y: this.#chartContext.yScaleState
    };
    
    console.log(`📊 ${this.#markId} Scale mappings setup:`, {
      x: this.actualXScaleType,
      y: this.actualYScaleType
    });
  }

  #buildFieldInfoRequests() {
    const { select, table } = this.#config;
    const requests = [];
    const processedFields = new Set();

    for (const alias in select) {
      const fieldName = select[alias];
      if (fieldName == null || processedFields.has(fieldName.toString())) continue;

      const exprNode = isNode(fieldName) ? fieldName : sqlColumn(String(fieldName));
      if (isAggregateExpression(exprNode)) continue;

      const scaleType = alias === 'x' ? this.actualXScaleType : alias === 'y' ? this.actualYScaleType : null;

      if (scaleType === 'linear' || scaleType === 'time' || scaleType === 'log') {
        requests.push({ table, column: exprNode, stats: ['min', 'max'] });
        processedFields.add(fieldName.toString());
      }
    }
    return requests;
  }
  
  #setInitialContinuousDomains(fieldInfo) {
    if (!fieldInfo) return;

    for (const alias in this.#scaleMap) {
      const scaleState = this.#scaleMap[alias];
      if (!scaleState) continue;

      const scaleType = alias === 'x' ? this.actualXScaleType : this.actualYScaleType;
      
      if (scaleType === 'linear' || scaleType === 'time' || scaleType === 'log') {
        const fieldName = this.#config.select[alias];
        if (fieldName == null) continue;

        const infoKey = String(fieldName).replace(/^["']|["']$/g, '');
        const info = fieldInfo[infoKey];

        if (info && info.min != null && info.max != null) {
          scaleState.addMark([info.min, info.max], this.#markId);
        }
      }
    }
  }

  async #fetchCategoricalDomains() {
    const { table, selection, sort } = this.#config;
    if (!this.#coordinator || !table) return;

    const fetches = [];

    const setupFetch = (axis, field) => {
      if (!field) return;
      const scaleState = this.#chartContext[`${axis}ScaleState`];
      let q = Query.from(table).select({ [axis]: sqlColumn(String(field)) });

      // Handle sorting for categorical domains
      const sortConfig = sort;
      if (sortConfig && sortConfig.by) {
        const isSortingByOtherAxis = sortConfig.by === (axis === 'x' ? 'y' : 'x');
        const otherAxisField = this.#config.select[sortConfig.by];
        if (isSortingByOtherAxis && isAggregateExpression(otherAxisField)) {
          q = q.groupby(field).select({ [sortConfig.by]: otherAxisField });
        }
        q.orderby({ [sortConfig.by]: sortConfig.direction === 'desc' ? 'DESC' : 'ASC' });
      } else {
        q.distinct();
      }

      fetches.push(
        this.#coordinator.query(q).then(result => {
          const categories = Array.from(result).map(row => row[axis]);
          if (categories.length > 0) {
            scaleState.addMark(categories, this.#markId);
          }
        })
      );
    };

    if (this.actualXScaleType === 'band' || this.actualXScaleType === 'point') {
      setupFetch('x', this.#config.select.x);
    }
    if (this.actualYScaleType === 'band' || this.actualYScaleType === 'point') {
      setupFetch('y', this.#config.select.y);
    }

    if (fetches.length > 0) await Promise.all(fetches);
  }

  #setScalesReady() {
    Object.values(this.#scaleMap).forEach(scale => scale?.setReady?.());
  }
}