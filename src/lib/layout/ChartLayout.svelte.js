// lib/layout/ChartLayout.svelte.js

/**
 * ChartLayout manages all chart dimensions, margins, and coordinate transformations.
 * Extracted from ChartContainer.svelte to improve modularity and testability.
 */
export class ChartLayout {
  // ✅ Class field declaration pattern (from docs)
  width = $state();
  height = $state();

  
  constructor(config = {}) {
    // Default configuration
    const defaults = {
      margin: { top: 30, right: 50, bottom: 35, left: 75 },
      height: 250,
      clipPadding: 0
    };

    // Merge user config with defaults
    this.config = { ...defaults, ...config };
    
    // ✅ First assignment in constructor pattern (from docs)
    this.height = this.config.height;
    
    // Non-reactive properties
    this.margin = this.config.margin;
    this.chartId = crypto.randomUUID();
  }

  // Computed properties using $derived would go here if this was a .svelte file
  // Since this is .js, we use getters that will be reactive when accessed from Svelte context
  
  /**
   * Inner chart width (total width minus left/right margins)
   */
  get innerWidth() {
    return this.width ? Math.max(0, this.width - this.margin.left - this.margin.right) : 0;
  }

  /**
   * Inner chart height (total height minus top/bottom margins)
   */
  get innerHeight() {
    return Math.max(0, this.height - this.margin.top - this.margin.bottom);
  }

  /**
   * Check if layout has valid dimensions for rendering
   */
  get isReady() {
    return this.width !== null && this.width > 0 && this.height > 0 && 
           this.innerWidth > 0 && this.innerHeight > 0;
  }

  /**
   * SVG transform string for translating to inner chart area
   */
  get innerTransform() {
    return `translate(${this.margin.left}, ${this.margin.top})`;
  }

  /**
   * Clip path ID for masking chart content to inner area
   */
  get clipPathId() {
    return `mask-${this.chartId}`;
  }

  /**
   * CSS/SVG clip path URL reference
   */
  get clipPathUrl() {
    return `url(#${this.clipPathId})`;
  }

  /**
   * Complete dimensions object for easy access
   */
  get dimensions() {
    return {
      width: this.width,
      height: this.height,
      innerWidth: this.innerWidth,
      innerHeight: this.innerHeight,
      margin: this.margin
    };
  }

  // Methods (using arrow functions to preserve 'this' binding per docs)
  updateWidth = (newWidth) => {
    this.width = newWidth;
  }

  updateHeight = (newHeight) => {
    this.height = newHeight;
  }

  updateMargin = (newMargin) => {
    this.margin = { ...this.margin, ...newMargin };
  }

  reset = () => {
    this.width = null;
    this.height = this.config.height;
    this.margin = { ...this.config.margin };
  }

  toInnerCoordinates = (point) => {
    return {
      x: point.x - this.margin.left,
      y: point.y - this.margin.top
    };
  }

  toScreenCoordinates = (innerPoint) => {
    return {
      x: innerPoint.x + this.margin.left,
      y: innerPoint.y + this.margin.top
    };
  }

  isWithinInnerBounds = (innerPoint) => {
    return {
      x: innerPoint.x >= 0 && innerPoint.x <= this.innerWidth,
      y: innerPoint.y >= 0 && innerPoint.y <= this.innerHeight,
      both: innerPoint.x >= 0 && innerPoint.x <= this.innerWidth && 
            innerPoint.y >= 0 && innerPoint.y <= this.innerHeight
    };
  }

  getActiveAxes = (point) => {
    const innerPoint = this.toInnerCoordinates(point);
    const bounds = this.isWithinInnerBounds(innerPoint);
    
    return {
      x: bounds.x,
      y: bounds.y, 
      innerPoint
    };
  }

  getDebugInfo = () => {
    return {
      config: this.config,
      width: this.width,
      height: this.height,
      margin: this.margin,
      innerWidth: this.innerWidth,
      innerHeight: this.innerHeight,
      isReady: this.isReady,
      chartId: this.chartId
    };
  }

  // Context data for reactive merging

  /**
   * Get context data with reactive getters for merging into chart context.
   * This is used by mergeReactive() to create the chart context object.
   * @returns {object} Object with getters that preserve reactivity
   */
  getContextData() {
    // Capture 'this' in closure to avoid binding issues in getters
    const layout = this;
    
    return {
      // Reactive properties - these are getters that will be called each time accessed
      get width() { return layout.width; },
      get height() { return layout.height; },
      get innerWidth() { return layout.innerWidth; },
      get innerHeight() { return layout.innerHeight; },
      get margin() { return layout.margin; },
      get chartId() { return layout.chartId; },
      get clipPathId() { return layout.clipPathId; },
      get clipPathUrl() { return layout.clipPathUrl; },
      get isReady() { return layout.isReady; },
      get innerTransform() { return layout.innerTransform; },
      get dimensions() { return layout.dimensions; },
      
      // Methods (bound to preserve 'this' context)
      updateWidth: layout.updateWidth.bind(layout),
      updateHeight: layout.updateHeight.bind(layout),
      updateMargin: layout.updateMargin.bind(layout),
      toInnerCoordinates: layout.toInnerCoordinates.bind(layout),
      toScreenCoordinates: layout.toScreenCoordinates.bind(layout),
      isWithinInnerBounds: layout.isWithinInnerBounds.bind(layout),
      getActiveAxes: layout.getActiveAxes.bind(layout),
      reset: layout.reset.bind(layout),
      getDebugInfo: layout.getDebugInfo.bind(layout)
    };
  }
}