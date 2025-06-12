import { getScaleState } from '$lib/scales';
import { resolveScaleType, SCALE_PRIORITIES } from './ScalePriorities.js';

export class ChartScales {
  // ✅ UPDATED: Store requirements as objects with priority info
  scaleRequirements = $state({
    x: [], // [{ type: 'band', priority: 3, markType: 'bar-abc123' }, ...]
    y: []  // [{ type: 'linear', priority: 2, markType: 'dot-def456' }, ...]
  });
  
  active = $state(false);

  constructor(config) {
    this.config = config;
  }

  // ✅ Reactive getters for config access
  get xLabel() { return this.config.xLabel; }
  get yLabel() { return this.config.yLabel; }
  get layout() { return this.config.layout; }

  // ✅ UPDATED: Resolve scale types using priority system
  scaleTypes = $derived({
    x: resolveScaleType(this.scaleRequirements.x),
    y: resolveScaleType(this.scaleRequirements.y)
  });

  // ✅ UPDATED: Use resolved scale types instead of hardcoded 'linear'
  xScaleState = $derived(getScaleState(this.xLabel, this.scaleTypes.x));
  yScaleState = $derived(getScaleState(this.yLabel, this.scaleTypes.y));

  // ✅ Base scales (unchanged)
  baseXScale = $derived(
    this.layout.isReady 
      ? this.xScaleState.getBaseScale('x', this.layout.innerWidth) 
      : null
  );

  baseYScale = $derived(
    this.layout.isReady 
      ? this.yScaleState.getBaseScale('y', this.layout.innerHeight) 
      : null
  );

  // ✅ Scales (unchanged)
  xScale = $derived(
    this.layout.isReady && this.baseXScale
      ? this.xScaleState.updateScaleDomain(this.baseXScale) 
      : null
  );

  yScale = $derived(
    this.layout.isReady && this.baseYScale
      ? this.yScaleState.updateScaleDomain(this.baseYScale) 
      : null
  );

  // ✅ Target scales (unchanged)
  xTargetScale = $derived(
    this.layout.isReady && this.baseXScale
      ? this.xScaleState.updateScaleDomain(this.baseXScale, false) 
      : null
  );

  yTargetScale = $derived(
    this.layout.isReady && this.baseYScale
      ? this.yScaleState.updateScaleDomain(this.baseYScale, false) 
      : null
  );

  // ✅ Current data points (unchanged)
  currentXDataPoint = $derived(this.xScaleState.currentDataPoint);
  currentYDataPoint = $derived(this.yScaleState.currentDataPoint);

  // ✅ Screen coordinates (unchanged)
  currentXScreenPoint = $derived(this.xScale?.scale(this.currentXDataPoint));
  currentYScreenPoint = $derived(this.yScale?.scale(this.currentYDataPoint));

  // ✅ Scales ready (unchanged)
  scalesReady = $derived(
    this.xScaleState?.ready && this.yScaleState?.ready
  );

  // ✅ NEW: Enhanced registerScaleType with priority support
  registerScaleType = (dimension, type, priority = SCALE_PRIORITIES.PREFER, markId = 'unknown') => {
    const requirements = this.scaleRequirements[dimension];
    
    // Check if we already have this exact requirement
    const existing = requirements.find(req => 
      req.type === type && 
      req.priority === priority && 
      req.markId === markId
    );
    
    if (!existing) {
      // Add new requirement
      requirements.push({ type, priority, markId });
      
      // console.log(`📊 Registered scale requirement: ${dimension} = ${type} (priority: ${priority}, mark: ${markId})`);
      
      // Trigger reactivity by reassigning the array
      this.scaleRequirements[dimension] = [...requirements];
    }
  }

  // ✅ NEW: Remove scale requirements for a specific mark
  unregisterScaleType = (dimension, markId) => {
    const requirements = this.scaleRequirements[dimension];
    const filtered = requirements.filter(req => req.markId !== markId);
    
    if (filtered.length !== requirements.length) {
      console.log(`📊 Removed scale requirements for ${markId} on ${dimension} axis`);
      this.scaleRequirements[dimension] = filtered;
    }
  }

  // ✅ NEW: Get current scale requirements summary for debugging
  getScaleRequirementsSummary = () => {
    return {
      x: {
        resolved: this.scaleTypes.x,
        requirements: this.scaleRequirements.x.map(req => 
          `${req.markId}:${req.type}(${req.priority})`
        )
      },
      y: {
        resolved: this.scaleTypes.y,
        requirements: this.scaleRequirements.y.map(req => 
          `${req.markId}:${req.type}(${req.priority})`
        )
      }
    };
  }

  // ✅ All interaction methods remain unchanged
  clearCurrentDataPoints = () => {
    this.xScaleState.currentDataPoint = null;
    this.yScaleState.currentDataPoint = null;
  }

  updateCurrentDataPoints = (innerPoint) => {
    if (this.scaleTypes.x === 'linear') {
      this.xScaleState.currentDataPoint = this.xScale?.scale.invert(innerPoint.x);
    }
    if (this.scaleTypes.y === 'linear') {
      this.yScaleState.currentDataPoint = this.yScale?.scale.invert(innerPoint.y);
    }
  }

  resetZoom = (axes = { x: true, y: true }) => {
    if (axes.x && this.scaleTypes.x === 'linear') {
      this.xScaleState.resetZoom();
    }
    if (axes.y && this.scaleTypes.y === 'linear') {
      this.yScaleState.resetZoom();
    }
  }

  applyZoom = (innerPoint, scaleFactor, doX, doY) => {
    if (doX && this.scaleTypes.x === 'linear') {
      this.xScaleState.applyZoomDomain(
        this.xScale.scale.invert(innerPoint.x), 
        scaleFactor, 
        'x', 
        this.layout.innerWidth
      );
    }
    if (doY && this.scaleTypes.y === 'linear') {
      this.yScaleState.applyZoomDomain(
        this.yScale.scale.invert(innerPoint.y), 
        scaleFactor, 
        'y', 
        this.layout.innerHeight
      );
    }
  }

  applyPan = (dx, dy, activePanX, activePanY) => {
    if (activePanX && this.scaleTypes.x === 'linear') {
      this.xScaleState.applyPanDomain(-dx);
    }
    if (activePanY && this.scaleTypes.y === 'linear') {
      this.yScaleState.applyPanDomain(-dy);
    }
  }

  calculatePanningAnchor = (innerPoint) => {
    return {
      x: this.scaleTypes.x === 'linear' ? this.xScale.scale.invert(innerPoint.x) : 0,
      y: this.scaleTypes.y === 'linear' ? this.yScale.scale.invert(innerPoint.y) : 0
    };
  }

  calculatePanDeltas = (innerPoint, panningAnchorPoint) => {
    return {
      dx: this.scaleTypes.x === 'linear' ? this.xScale.scale.invert(innerPoint.x) - panningAnchorPoint.x : 0,
      dy: this.scaleTypes.y === 'linear' ? this.yScale.scale.invert(innerPoint.y) - panningAnchorPoint.y : 0
    };
  }

  // ✅ UPDATED: Context data includes new methods
  getContextData() {
    const coordinator = this;
    
    return {
      get xScale() { return coordinator.xScale?.scale; },
      get yScale() { return coordinator.yScale?.scale; },
      get xTargetScale() { return coordinator.xTargetScale?.scale; },
      get yTargetScale() { return coordinator.yTargetScale?.scale; },
      
      get xLabel() { return coordinator.xLabel; },
      get yLabel() { return coordinator.yLabel; },
      
      get currentXDataPoint() { return coordinator.currentXDataPoint; },
      get currentYDataPoint() { return coordinator.currentYDataPoint; },
      get currentXScreenPoint() { return coordinator.currentXScreenPoint; },
      get currentYScreenPoint() { return coordinator.currentYScreenPoint; },
      
      get xScaleState() { return coordinator.xScaleState; },
      get yScaleState() { return coordinator.yScaleState; },
      
      get scaleTypes() { return coordinator.scaleTypes; },
      get scalesReady() { return coordinator.scalesReady; },
      get active() { return coordinator.active; },
      
      // ✅ NEW: Enhanced registration methods
      registerScaleType: coordinator.registerScaleType,
      unregisterScaleType: coordinator.unregisterScaleType,
      getScaleRequirementsSummary: coordinator.getScaleRequirementsSummary
    };
  }
}