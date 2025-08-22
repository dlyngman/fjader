// src/lib/scales/BandScaleState.svelte.js
import { scaleBand } from 'd3-scale';

export class BandScaleState {
  id = crypto.randomUUID();
  name = $state('');
  type = 'band';
  ready = $state(false);

  #domain = $state([]);
  #extents = new Map(); // Stores all domains from different marks

  // ✅ ENHANCED: Configuration properties from resolved config
  #padding = 0.1;
  #paddingInner = null;
  #paddingOuter = null;
  #align = 0.5;

  // Freeze/debounce functionality
  #enableUpdates = $state(true);
  #frozenDomain = null;

  // ✅ NEW: Reactive category→index mapping cache
  #categoryIndexMap = $derived.by(() => {
    const domain = this.#enableUpdates ? this.#domain : this.#frozenDomain || this.#domain;
    
    const map = new Map();
    domain.forEach((category, index) => {
      map.set(category, index);
    });
    return map;
  });

  // ✅ ENHANCED: Constructor now accepts and applies resolved configuration
  constructor(name, domain = [], config = {}) {
    this.name = name;
    this.#domain = [...domain];
    
    // Apply resolved configuration with defaults
    this.#padding = config.padding ?? 0.1;
    this.#paddingInner = config.paddingInner ?? null;
    this.#paddingOuter = config.paddingOuter ?? null;
    this.#align = config.align ?? 0.5;
    
    console.log(`🏗️ BandScaleState "${name}" created with configuration:`, {
      padding: this.#padding,
      paddingInner: this.#paddingInner,
      paddingOuter: this.#paddingOuter,
      align: this.#align,
      resolvedFrom: Object.keys(config).length > 0 ? 'mark requirements' : 'defaults'
    });
  }

  setReady() {
    this.ready = true;
  }

  /**
   * Enable or disable scale updates
   */
  setUpdatesEnabled(enabled) {
    const wasEnabled = this.#enableUpdates;
    this.#enableUpdates = enabled;
    
    if (wasEnabled && !enabled) {
      this.#frozenDomain = [...this.#domain];
    } else if (!wasEnabled && enabled) {
      this.#frozenDomain = null;
      this.updateDomainFromExtents();
    }
  }

  get updatesEnabled() {
    return this.#enableUpdates;
  }

  get effectiveDomain() {
    return this.#enableUpdates ? this.#domain : this.#frozenDomain || this.#domain;
  }

  /**
   * Check if the scale is ready for GPU processing
   * @returns {boolean} True if scale has categories and mapping is ready
   */
  get isReadyForGPU() {
    return this.ready && 
           this.effectiveDomain.length > 0 && 
           this.#categoryIndexMap instanceof Map &&
           this.#extents.size > 0;
  }

  /**
   * Add categorical data from a mark
   */
  addMark(categories, identifier) {
    const uniqueCategories = [...new Set(categories.filter(c => c != null))];
    
    this.#extents.set(identifier, uniqueCategories);

    if (this.#enableUpdates) {
      this.updateDomainFromExtents();
    }
    return this;
  }

  removeMark(identifier) {
    if (this.#extents.has(identifier)) {
      this.#extents.delete(identifier);

      if (this.#enableUpdates) {
        this.updateDomainFromExtents();
      }
    }
    return this;
  }

  /**
   * Update domain based on all categories from all marks
   */
  updateDomainFromExtents() {
    if (!this.#enableUpdates) {
      return;
    }

    if (this.#extents.size === 0) {
      this.#domain = [];
      return;
    }
    
    // Collect all unique categories while preserving order
    const allCategories = [];
    const seen = new Set();
    
    for (const categories of this.#extents.values()) {
      for (const category of categories) {
        if (!seen.has(category)) {
          seen.add(category);
          allCategories.push(category);
        }
      }
    }
    
    this.#domain = allCategories;
  }

  /**
   * Convert categorical data to indices for GPU processing
   * @param {Array} categoryData - Array of category values from mark data
   * @param {string} markId - Identifier for the mark (for debugging)
   * @returns {Float32Array} Array of indices corresponding to categories
   */
  processDataForGPU(categoryData, markId = 'unknown') {
    const categoryMap = this.#categoryIndexMap;
    
    if (!(categoryMap instanceof Map)) {
      console.error(`🚨 BandScale "${this.name}": categoryMap is not a Map:`, categoryMap);
      const fallbackMap = new Map();
      this.effectiveDomain.forEach((category, index) => {
        fallbackMap.set(category, index);
      });
      return this.#processWithMap(categoryData, fallbackMap, markId);
    }
    
    return this.#processWithMap(categoryData, categoryMap, markId);
  }

  /**
   * Helper method to process data with a given category map
   * @private
   */
  #processWithMap(categoryData, categoryMap, markId) {
    const unmappedCategories = new Set();
    
    const indices = new Float32Array(categoryData.map(category => {
      const index = categoryMap.get(category);
      if (index !== undefined) {
        return index;
      } else {
        unmappedCategories.add(category);
        return 0; // Default to first category index
      }
    }));

    // Warn about unmapped categories in development
    if (unmappedCategories.size > 0 && process.env.NODE_ENV === 'development') {
      console.warn(
        `🔶 BandScale "${this.name}": Unmapped categories for mark "${markId}":`,
        Array.from(unmappedCategories).slice(0, 5),
        unmappedCategories.size > 5 ? `... and ${unmappedCategories.size - 5} more` : '',
        `\nValid categories:`, $state.snapshot(this.effectiveDomain)
      );
    }

    return indices;
  }

  getCategoryIndexMap() {
    return new Map(this.#categoryIndexMap);
  }

  getExtents() {
    return Object.fromEntries(this.#extents);
  }

  /**
   * ✅ ENHANCED: Create base D3 band scale using resolved configuration
   */
  getBaseScale(axis, innerWidthOrHeight) {
    const scale = scaleBand().range(
      axis === 'x' ? [0, innerWidthOrHeight] : [innerWidthOrHeight, 0]
    );

    // ✅ Apply resolved padding configuration
    if (this.#paddingInner !== null && this.#paddingOuter !== null) {
      scale.paddingInner(this.#paddingInner).paddingOuter(this.#paddingOuter);
      console.log(`🎯 Applied fine-grained padding to ${axis}-scale "${this.name}":`, {
        paddingInner: this.#paddingInner,
        paddingOuter: this.#paddingOuter,
        align: this.#align
      });
    } else {
      scale.padding(this.#padding);
      console.log(`🎯 Applied simple padding to ${axis}-scale "${this.name}":`, {
        padding: this.#padding,
        align: this.#align
      });
    }

    // ✅ Apply alignment configuration
    if (this.#align !== 0.5) {
      scale.align(this.#align);
    }

    return scale;
  }

  /**
   * Update scale domain - bands don't animate like linear scales
   */
  updateScaleDomain(scale) {
    return { scale: scale.domain(this.effectiveDomain) };
  }

  /**
   * Get positioning information for a category
   */
  getPosition(category) {
    const index = this.effectiveDomain.indexOf(category);
    if (index === -1) return { current: 0 };
    
    return { 
      current: index / Math.max(1, this.effectiveDomain.length - 1) 
    };
  }

  // No-op methods for API consistency
  applyZoomDomain() { return; }
  applyPanDomain() { return; }
  resetZoom() { return; }

  gpuState = $derived.by(() => {
    const categoryCount = this.#categoryIndexMap.size;

    return {
        domainMin: 0,
        domainMax: Math.max(0, categoryCount - 1),
        categoryCount: categoryCount,
        domainScale: 0,
    };
  });

  /**
   * ✅ ENHANCED: Debug info now includes configuration details
   */
  getDebugInfo() {
    return {
      updatesEnabled: this.#enableUpdates,
      currentDomain: [...this.#domain],
      frozenDomain: this.#frozenDomain ? [...this.#frozenDomain] : null,
      effectiveDomain: [...this.effectiveDomain],
      extentsCount: this.#extents.size,
      extents: Object.fromEntries(this.#extents),
      
      // ✅ NEW: Configuration details
      configuration: {
        padding: this.#padding,
        paddingInner: this.#paddingInner,
        paddingOuter: this.#paddingOuter,
        align: this.#align
      },
      
      categoryIndexMap: Object.fromEntries(this.#categoryIndexMap),
      categoryCount: this.effectiveDomain.length
    };
  }

  destroy() {
    this.#frozenDomain = null;
    this.#extents.clear();
  }
}