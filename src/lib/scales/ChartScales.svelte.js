// src/lib/scales/ChartScales.svelte.js
import { getScaleState } from '$lib/scales';
import { resolveScaleConfiguration, SCALE_PRIORITIES } from './ScalePriorities.js';

export class ChartScales {
  scaleRequirements = $state({
    x: [], // [{ type: 'band', priority: 3, markId: 'bar-abc123', config: {...} }, ...]
    y: []  // [{ type: 'linear', priority: 2, markId: 'dot-def456', config: {...} }, ...]
  });
  
  active = $state(false);

  constructor(config) {
    this.config = config;
  }

  // ✅ Reactive getters for config access
  get xLabel() { return this.config.xLabel; }
  get yLabel() { return this.config.yLabel; }
  get layout() { return this.config.layout; }

  // ✅ NEW: Enhanced resolution with configuration support
  scaleConfigurations = $derived.by(() => {
    try {
      return {
        x: resolveScaleConfiguration(this.scaleRequirements.x),
        y: resolveScaleConfiguration(this.scaleRequirements.y)
      };
    } catch (error) {
      console.error('❌ Scale configuration resolution failed:', error);
      
      // Provide helpful debugging info
      console.error('Scale requirements at time of error:', {
        x: this.scaleRequirements.x.map(req => `${req.markId}:${req.type}(${req.priority})`),
        y: this.scaleRequirements.y.map(req => `${req.markId}:${req.type}(${req.priority})`)
      });
      
      // Return safe fallback
      return { 
        x: { type: 'linear', config: {} }, 
        y: { type: 'linear', config: {} } 
      };
    }
  });

  // ✅ Derive types from configurations for backward compatibility
  scaleTypes = $derived.by(() => ({
    x: this.scaleConfigurations?.x?.type || 'linear',
    y: this.scaleConfigurations?.y?.type || 'linear'
  }));

  // ✅ NEW: Use resolved configurations with scale states
  xScaleState = $derived(getScaleState(
    this.xLabel, 
    this.scaleConfigurations?.x?.type || 'linear',
    this.scaleConfigurations?.x?.config || {}
  ));

  yScaleState = $derived(getScaleState(
    this.yLabel, 
    this.scaleConfigurations?.y?.type || 'linear', 
    this.scaleConfigurations?.y?.config || {}
  ));

  // Rest of the class remains the same...
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

  currentXDataPoint = $derived(this.xScaleState.currentDataPoint);
  currentYDataPoint = $derived(this.yScaleState.currentDataPoint);
  currentXScreenPoint = $derived(this.xScale?.scale(this.currentXDataPoint));
  currentYScreenPoint = $derived(this.yScale?.scale(this.currentYDataPoint));
  scalesReady = $derived(this.xScaleState?.ready && this.yScaleState?.ready);

  // ✅ ENHANCED: registerScaleType with configuration support
  registerScaleType = (dimension, type, priority = SCALE_PRIORITIES.PREFER, markId = 'unknown', config = {}) => {
    const requirements = this.scaleRequirements[dimension];
    
    // Check if we already have this exact requirement
    const existing = requirements.find(req => 
      req.type === type && 
      req.priority === priority && 
      req.markId === markId &&
      JSON.stringify(req.config) === JSON.stringify(config)
    );
    
    if (!existing) {
      requirements.push({ type, priority, markId, config });
      
      console.log(`📊 Registered scale requirement: ${dimension} = ${type} (priority: ${priority}, mark: ${markId})`, {
        config: Object.keys(config).length > 0 ? config : 'none'
      });
      
      // Trigger reactivity by reassigning the array
      this.scaleRequirements[dimension] = [...requirements];
    }
  }

  unregisterScaleType = (dimension, markId) => {
    const requirements = this.scaleRequirements[dimension];
    const filtered = requirements.filter(req => req.markId !== markId);
    
    if (filtered.length !== requirements.length) {
      console.log(`📊 Removed scale requirements for ${markId} on ${dimension} axis`);
      this.scaleRequirements[dimension] = filtered;
    }
  }

  // ✅ ENHANCED: Summary now includes configuration info
  getScaleRequirementsSummary = () => {
    return {
      x: {
        resolved: this.scaleTypes?.x || 'unknown',
        config: this.scaleConfigurations?.x?.config || {},
        requirements: this.scaleRequirements.x.map(req => 
          `${req.markId}:${req.type}(${req.priority})${Object.keys(req.config || {}).length > 0 ? '+config' : ''}`
        )
      },
      y: {
        resolved: this.scaleTypes?.y || 'unknown', 
        config: this.scaleConfigurations?.y?.config || {},
        requirements: this.scaleRequirements.y.map(req => 
          `${req.markId}:${req.type}(${req.priority})${Object.keys(req.config || {}).length > 0 ? '+config' : ''}`
        )
      }
    };
  }

  // All interaction methods remain unchanged...
  clearCurrentDataPoints = () => {
    this.xScaleState.currentDataPoint = null;
    this.yScaleState.currentDataPoint = null;
  }

  updateCurrentDataPoints = (innerPoint) => {
    if (this.scaleTypes?.y === 'linear') {
      this.yScaleState.currentDataPoint = this.yScale?.scale.invert(innerPoint.y);
    }
    if (this.scaleTypes?.x === 'linear') {
      this.xScaleState.currentDataPoint = this.xScale?.scale.invert(innerPoint.x);
    }
  }

  resetZoom = (axes = { x: true, y: true }) => {
    if (axes.x && this.scaleTypes?.x === 'linear') {
      this.xScaleState.resetZoom();
    }
    if (axes.y && this.scaleTypes?.y === 'linear') {
      this.yScaleState.resetZoom();
    }
  }

  applyZoom = (innerPoint, scaleFactor, doX, doY) => {
    if (doX && this.scaleTypes?.x === 'linear') {
      this.xScaleState.applyZoomDomain(
        this.xScale.scale.invert(innerPoint.x), 
        scaleFactor, 
        'x', 
        this.layout.innerWidth
      );
    }
    if (doY && this.scaleTypes?.y === 'linear') {
      this.yScaleState.applyZoomDomain(
        this.yScale.scale.invert(innerPoint.y), 
        scaleFactor, 
        'y', 
        this.layout.innerHeight
      );
    }
  }

  applyPanDomain = (newDomain, axis) => {
    if (axis === 'x' && this.scaleTypes?.x === 'linear') {
      this.xScaleState.setConstrainedDomain(newDomain);
    }
    if (axis === 'y' && this.scaleTypes?.y === 'linear') {
      this.yScaleState.setConstrainedDomain(newDomain);
    }
  }

  calculatePanningAnchor = (innerPoint) => {
    return {
      x: this.scaleTypes?.x === 'linear' ? this.xScale.scale.invert(innerPoint.x) : 0,
      y: this.scaleTypes?.y === 'linear' ? this.yScale.scale.invert(innerPoint.y) : 0
    };
  }

  calculatePanDeltas = (innerPoint, panningAnchorPoint) => {
    return {
      dx: this.scaleTypes?.x === 'linear' ? this.xScale.scale.invert(innerPoint.x) - panningAnchorPoint.x : 0,
      dy: this.scaleTypes?.y === 'linear' ? this.yScale.scale.invert(innerPoint.y) - panningAnchorPoint.y : 0
    };
  }

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
      
      // ✅ NEW: Expose scale configurations
      get scaleConfigurations() { return coordinator.scaleConfigurations; },
      
      registerScaleType: coordinator.registerScaleType,
      unregisterScaleType: coordinator.unregisterScaleType,
      getScaleRequirementsSummary: coordinator.getScaleRequirementsSummary
    };
  }
}