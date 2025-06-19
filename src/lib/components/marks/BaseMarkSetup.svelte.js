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
  constructor(config, coordinator, chartContext) {
    this.#config = config;
    this.#coordinator = coordinator;
    this.#chartContext = chartContext;
    this.#markId = `${config.markType}-${crypto.randomUUID().slice(0, 8)}`;

    // ✅ Register scale requirements immediately in constructor
    // this.#registerScaleRequirements();

    // ✅ Setup reactive effects for initialization
    this.#setupReactiveEffects();
  }

  registerInitialScaleRequirements() {
    console.log(`📊 Registering initial scale requirements for mark ${this.#markId}`);
    this.#registerScaleRequirements();
  }

  // =================================================================
  // ==  REACTIVE SETUP EFFECTS                                     ==
  // =================================================================

  #setupReactiveEffects() {
    // // Effect 0: Register scale requirements (runs first, once)
    // $effect(() => {
    //   if (this.#chartContext && this.#config.scaleRequirements) {
    //     console.log(`📊 Registering scale requirements for mark ${this.#markId}`);
    //     this.#registerScaleRequirements();
    //   }
    // });

    // Effect 1: Monitor scale states readiness
    $effect(() => {
      const { scaleTypes, xScaleState, yScaleState } = this.#chartContext;
      
      const ready = !!(scaleTypes && xScaleState && yScaleState);
      
      if (ready && !this.#scaleStatesReady) {
        console.log(`📊 Scale states ready for mark ${this.#markId}`);
        this.#scaleStatesReady = true;
      }
    });

    // Effect 2: Setup scale mappings when scale states are ready
    $effect(() => {
      if (this.#scaleStatesReady && !this.#scaleMappingsReady) {
        try {
          console.log(`🔗 Setting up scale mappings for mark ${this.#markId}`);
          this.#setupScaleMappings();
          this.#scaleMappingsReady = true;
        } catch (error) {
          console.error(`❌ Scale mapping failed for ${this.#markId}:`, error);
        }
      }
    });

    // Effect 3: Create client when scale mappings are ready
    $effect(() => {
      if (this.#scaleMappingsReady && !this.#clientCreated) {
        try {
          console.log(`🚀 Creating client for mark ${this.#markId}`);
          const fieldRequests = this.#buildFieldInfoRequests();
          this.createClient(fieldRequests);
          this.#clientCreated = true;
        } catch (error) {
          console.error(`❌ Client creation failed for ${this.#markId}:`, error);
        }
      }
    });

    // Effect 4: Monitor client data readiness
    $effect(() => {
      if (this.#clientCreated && this.client?.fieldInfo && !this.#clientDataReady) {
        console.log(`📋 Client data ready for mark ${this.#markId}`);
        this.#clientDataReady = true;
      }
    });

    // Effect 5: Set initial continuous domains when client data is ready
    $effect(() => {
      if (this.#clientDataReady && !this.#continuousDomainsSet) {
        try {
          console.log(`📐 Setting initial continuous domains for mark ${this.#markId}`);
          this.#setInitialContinuousDomains(this.client.fieldInfo);
          this.#continuousDomainsSet = true;
        } catch (error) {
          console.error(`❌ Setting continuous domains failed for ${this.#markId}:`, error);
        }
      }
    });

    // Effect 6: Start categorical domain fetch when continuous domains are set
    $effect(() => {
      if (this.#continuousDomainsSet && !this.#categoricalFetchStarted) {
        console.log(`🏷️ Starting categorical domain fetch for mark ${this.#markId}`);
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

    // ✅ NEW: Force reconnection when chartContext/scales change
    $effect(() => {
      const currentXScaleState = this.#chartContext.xScaleState;
      const currentYScaleState = this.#chartContext.yScaleState;
      
      // Track if we have different scale state instances
      if (currentXScaleState && currentYScaleState) {
        const scaleStatesChanged = 
          this.#scaleMap?.x !== currentXScaleState || 
          this.#scaleMap?.y !== currentYScaleState;
          
        if (scaleStatesChanged && this.#clientCreated) {
          console.log(`🔄 ${this.#markId} Scale states changed, forcing reconnection`);
          this.#resetSetupState();
        }
      }
    });

    // Debug effect (only in development)
    if (process.env.NODE_ENV === 'development') {
      $effect(() => {
        const progress = {
          scaleStatesReady: this.#scaleStatesReady,
          scaleMappingsReady: this.#scaleMappingsReady,
          clientCreated: this.#clientCreated,
          clientDataReady: this.#clientDataReady,
          continuousDomainsSet: this.#continuousDomainsSet,
          categoricalFetchStarted: this.#categoricalFetchStarted,
          categoricalDataFetched: this.categoricalDataFetched
        };
        
        console.debug(`🔍 Setup progress for ${this.#markId}:`, progress);
      });
    }
  }

  // =================================================================
  // ==  SCALE REGISTRATION (MOVED FROM COMPONENT)                 ==
  // =================================================================

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

  /**
   * Update scale requirements (called when scale type preferences change)
   */
  updateScaleRequirements(newRequirements) {
    // Unregister old requirements
    this.#chartContext.unregisterScaleType('x', this.#markId);
    this.#chartContext.unregisterScaleType('y', this.#markId);
    
    // Update config
    this.#config.scaleRequirements = newRequirements;
    
    // Register new requirements
    this.#registerScaleRequirements();

    // Reset setup state to trigger re-initialization
    this.#resetSetupState();
  }

  /**
   * Reset setup state to trigger re-initialization
   */
  #resetSetupState() {
    this.#scaleStatesReady = false;
    this.#scaleMappingsReady = false;
    this.#clientCreated = false;
    this.#clientDataReady = false;
    this.#continuousDomainsSet = false;
    this.#categoricalFetchStarted = false;
    this.categoricalDataFetched = false;
    
    // Clean up existing client
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    
    // Clean up scale data
    this.#cleanupScaleData();
  }

  // =================================================================
  // ==  PUBLIC GETTERS & DERIVED STATE                           ==
  // =================================================================

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

  // =================================================================
  // ==  REACTIVE CONFIGURATION UPDATES                            ==
  // =================================================================

  /**
   * Handles updates to the component's props - now reactive
   */
  async updateConfig(newConfig) {
    const oldConfig = this.#config;
    this.#config = { ...oldConfig, ...newConfig };
    
    const needsReset = ['table', 'selection', 'x', 'y', 'color', 'select'].some(
      key => newConfig[key] !== undefined && !this.#deepEqual(newConfig[key], oldConfig[key])
    );

    if (needsReset) {
      console.log(`🔄 ${this.#markId} Config change requires reset`);
      this.#resetSetupState();
    } else {
      console.log(`📝 ${this.#markId} Config updated without reset`);
    }
  }

  #cleanupScaleData() {
    Object.values(this.#scaleMap).forEach(scale => {
      if (scale?.removeMark) {
        scale.removeMark(this.#markId);
      }
    });
  }

  /**
   * Cleans up all resources used by this mark controller.
   */
  destroy() {
    console.log(`🧹 Destroying mark ${this.#markId}`);
    
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

  // =================================================================
  // ==  QUERY & DATA LOGIC (designed for extension)                ==
  // =================================================================

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

  // =================================================================
  // ==  PRIVATE HELPER METHODS                                     ==
  // =================================================================

  createClient(fieldRequests) {
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

  #deepEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    
    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!this.#deepEqual(a[key], b[key])) return false;
    }
    
    return true;
  }
}