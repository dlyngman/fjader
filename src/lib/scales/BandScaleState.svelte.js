import { scaleBand } from 'd3-scale';

export class BandScaleState {
  // Basic scale properties
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
      padding: this.#padding
    };
  }

  destroy() {
    this.#frozenDomain = null;
    this.#extents.clear();
  }
}