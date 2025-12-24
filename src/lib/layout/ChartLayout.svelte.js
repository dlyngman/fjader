// lib/layout/ChartLayout.svelte.js

/**
 * ChartLayout manages all chart dimensions, margins, and coordinate transformations.
 * OPTIMIZED FOR ZERO-GC INTERACTION LOOPS.
 */
export class ChartLayout {
  // Reactive state
  width = $state(0);
  height = $state(0);
  margin = $state({ top: 0, right: 0, bottom: 0, left: 0 });
  
  // --- ZERO-GC BUFFERS ---
  // Reused objects to prevent allocation during high-frequency events (pointermove, wheel)
  _axesBuffer = { 
    x: false, 
    y: false, 
    innerPoint: { x: 0, y: 0 } 
  };
  
  _pointBuffer = { x: 0, y: 0 };

  constructor(config = {}) {
    const defaults = {
      margin: { top: 30, right: 50, bottom: 35, left: 75 },
      height: 250,
      clipPadding: 0
    };

    this.config = { ...defaults, ...config };
    
    // Initialize state
    this.height = this.config.height;
    this.margin = this.config.margin; // Triggers reactivity
    
    this.chartId = crypto.randomUUID();
  }

  // --- COMPUTED PROPERTIES (Getters) ---
  
  get innerWidth() {
    return this.width ? Math.max(0, this.width - this.margin.left - this.margin.right) : 0;
  }

  get innerHeight() {
    return Math.max(0, this.height - this.margin.top - this.margin.bottom);
  }

  get isReady() {
    return this.width !== null && this.width > 0 && this.height > 0 && 
           this.innerWidth > 0 && this.innerHeight > 0;
  }

  get innerTransform() {
    return `translate(${this.margin.left}, ${this.margin.top})`;
  }

  get clipPathId() {
    return `mask-${this.chartId}`;
  }

  get clipPathUrl() {
    return `url(#${this.clipPathId})`;
  }

  // Warning: accessing this creates a new object. Use mostly for debugging.
  get dimensions() {
    return {
      width: this.width,
      height: this.height,
      innerWidth: this.innerWidth,
      innerHeight: this.innerHeight,
      margin: this.margin
    };
  }

  // --- METHODS ---

  updateWidth = (newWidth) => {
    this.width = newWidth;
  }

  updateHeight = (newHeight) => {
    this.height = newHeight;
  }

  updateMargin = (newMargin) => {
    // Deep merge into existing state object to preserve reference if possible,
    // but spreading is fine here as margins don't change at 60fps.
    this.margin = { ...this.margin, ...newMargin };
  }

  reset = () => {
    this.width = null;
    this.height = this.config.height;
    this.margin = { ...this.config.margin };
  }

  // --- HOT PATH METHODS (Optimized) ---

  // OPTIMIZED: Mutates shared buffer instead of returning new {x,y}
  toInnerCoordinates = (point) => {
    this._pointBuffer.x = point.x - this.margin.left;
    this._pointBuffer.y = point.y - this.margin.top;
    return this._pointBuffer;
  }

  // Alias for converting specific x/y numbers (Better for internal use)
  toInnerRaw = (x, y) => {
    this._pointBuffer.x = x - this.margin.left;
    this._pointBuffer.y = y - this.margin.top;
    return this._pointBuffer;
  }

  toScreenCoordinates = (innerPoint) => {
    // Used less frequently in hot paths, but we reuse the same buffer
    this._pointBuffer.x = innerPoint.x + this.margin.left;
    this._pointBuffer.y = innerPoint.y + this.margin.top;
    return this._pointBuffer;
  }

  // OPTIMIZED: Returns primitive boolean
  // Logic: Check if point (screen coords) is inside the chart area
  isWithinInnerBounds = (point) => {
    const x = point.x - this.margin.left;
    const y = point.y - this.margin.top;
    
    return x >= 0 && x <= this.innerWidth && 
           y >= 0 && y <= this.innerHeight;
  }

  // OPTIMIZED: The heavy lifter.
  // Calculates everything in one pass and returns a persistent buffer object.
  getActiveAxes = (point) => {
    // 1. Calculate Inner Coords
    const ix = point.x - this.margin.left;
    const iy = point.y - this.margin.top;
    
    // 2. Check Bounds
    const inX = ix >= 0 && ix <= this.innerWidth;
    const inY = iy >= 0 && iy <= this.innerHeight;

    // 3. Mutate Buffer (Zero Allocation)
    this._axesBuffer.x = inX;
    this._axesBuffer.y = inY;
    this._axesBuffer.innerPoint.x = ix;
    this._axesBuffer.innerPoint.y = iy;
    
    // 4. Return Buffer
    return this._axesBuffer;
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

  /**
   * Context data merging.
   * Removed .bind() calls because arrow functions handles 'this' automatically.
   */
  getContextData() {
    const layout = this;
    
    return {
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
      
      updateWidth: layout.updateWidth,
      updateHeight: layout.updateHeight,
      updateMargin: layout.updateMargin,
      toInnerCoordinates: layout.toInnerCoordinates,
      toScreenCoordinates: layout.toScreenCoordinates,
      isWithinInnerBounds: layout.isWithinInnerBounds,
      getActiveAxes: layout.getActiveAxes,
      reset: layout.reset,
      getDebugInfo: layout.getDebugInfo
    };
  }
}