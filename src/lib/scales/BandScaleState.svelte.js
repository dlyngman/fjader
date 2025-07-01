import { scaleBand } from 'd3-scale';

export class BandScaleState {
  id = crypto.randomUUID();
  name = $state('');
  type = 'band';
  ready = $state(false);

  #domain = $state([]);
  #extents = new Map(); // Stores all domains from different marks

  // Band-specific properties
  #padding = 0.1;
  #paddingInner = null;
  #paddingOuter = null;

  // Freeze/debounce functionality
  #enableUpdates = $state(true);
  #frozenDomain = null;

  // ✅ NEW: Reactive category→index mapping cache
  #categoryIndexMap = $derived.by(() => {
    // Make dependencies explicit for proper reactivity tracking
    const domain = this.#enableUpdates ? this.#domain : this.#frozenDomain || this.#domain;
    
    const map = new Map();
    domain.forEach((category, index) => {
      map.set(category, index);
    });
    return map;
  });

  constructor(name, domain = [], options = {}) {
    this.name = name;
    this.#domain = [...domain];
    this.#padding = options.padding ?? 0.1;
    this.#paddingInner = options.paddingInner ?? null;
    this.#paddingOuter = options.paddingOuter ?? null;
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
           this.#extents.size > 0; // Ensure we have received data from marks
  }

  /**
   * Add categorical data from a mark
   */
  addMark(categories, identifier) {
    // Get unique categories, preserving order of first appearance
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

  // ✅ NEW: Process categorical data for GPU consumption
  /**
   * Convert categorical data to indices for GPU processing
   * This is the authoritative source for category→index conversion
   * @param {Array} categoryData - Array of category values from mark data
   * @param {string} markId - Identifier for the mark (for debugging)
   * @returns {Float32Array} Array of indices corresponding to categories
   */
  processDataForGPU(categoryData, markId = 'unknown') {
    const categoryMap = this.#categoryIndexMap;
    
    // Defensive check - ensure we have a valid Map
    if (!(categoryMap instanceof Map)) {
      console.error(`🚨 BandScale "${this.name}": categoryMap is not a Map:`, categoryMap);
      console.error('Domain state:', {
        enableUpdates: this.#enableUpdates,
        domain: this.#domain,
        frozenDomain: this.#frozenDomain,
        effectiveDomain: this.effectiveDomain
      });
      // Fallback: create a temporary mapping
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

    // Warn about unmapped categories in development with full context
    if (unmappedCategories.size > 0 && process.env.NODE_ENV === 'development') {
      console.warn(
        `🔶 BandScale "${this.name}": Unmapped categories for mark "${markId}":`,
        Array.from(unmappedCategories).slice(0, 5), // Limit output for readability
        unmappedCategories.size > 5 ? `... and ${unmappedCategories.size - 5} more` : '',
        `\nValid categories:`, $state.snapshot(this.effectiveDomain)
      );
    }

    return indices;
  }

  /**
   * Get the current category→index mapping (for debugging)
   * @returns {Map} Current category→index mapping
   */
  getCategoryIndexMap() {
    return new Map(this.#categoryIndexMap);
  }

  getExtents() {
    return Object.fromEntries(this.#extents);
  }

  /**
   * Create base D3 band scale
   */
  getBaseScale(axis, innerWidthOrHeight) {
    const scale = scaleBand().range(
      axis === 'x' ? [0, innerWidthOrHeight] : [innerWidthOrHeight, 0]
    );

    // Apply padding configuration
    if (this.#paddingInner !== null && this.#paddingOuter !== null) {
      scale.paddingInner(this.#paddingInner).paddingOuter(this.#paddingOuter);
    } else {
      scale.padding(this.#padding);
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
   * Used by the axis renderer for proper tick positioning
   */
  getPosition(category) {
    // This would be used by axes to position ticks correctly
    const index = this.effectiveDomain.indexOf(category);
    if (index === -1) return { current: 0 };
    
    // Return normalized position (0-1) - will be converted to pixels by the scale
    return { 
      current: index / Math.max(1, this.effectiveDomain.length - 1) 
    };
  }

  /**
   * Band scales don't typically support zoom/pan interactions
   * These methods exist for API consistency but are no-ops
   */
  applyZoomDomain() {
    // Bands don't zoom
    return;
  }

  applyPanDomain() {
    // Bands don't pan
    return;
  }

  resetZoom() {
    // No zoom to reset for bands
    return;
  }

  gpuState = $derived.by(() => {
    const categoryCount = this.#categoryIndexMap.size;

    return {
        domainMin: 0,
        domainMax: Math.max(0, categoryCount - 1),
        categoryCount: categoryCount,
        domainScale: 0, // Fulfills the interface contract with a sensible default
    };
  });

  /**
   * Get debug information
   */
  getDebugInfo() {
    return {
      updatesEnabled: this.#enableUpdates,
      currentDomain: [...this.#domain],
      frozenDomain: this.#frozenDomain ? [...this.#frozenDomain] : null,
      effectiveDomain: [...this.effectiveDomain],
      extentsCount: this.#extents.size,
      extents: Object.fromEntries(this.#extents),
      padding: this.#padding,
      categoryIndexMap: Object.fromEntries(this.#categoryIndexMap), // Show current mapping
      categoryCount: this.effectiveDomain.length
    };
  }

  destroy() {
    this.#frozenDomain = null;
    this.#extents.clear();
  }
}