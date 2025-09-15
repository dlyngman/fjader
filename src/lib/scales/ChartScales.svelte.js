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
    this.gpuCoordinator = config.gpuCoordinator;

    // Update gpuCoordinator scale ids 
    $effect(() => {
      const xScale = this.xScaleState;
      const yScale = this.yScaleState;
      
      if (xScale?.id && yScale?.id && this.gpuCoordinator) {
        const trySetMapping = () => {
          try {
            this.gpuCoordinator.setChartScaleMapping(this.chartId, {
              xScaleId: xScale.id,
              yScaleId: yScale.id
            });
          } catch (error) {
            console.log('setMapping failed')
            // Retry after chart registration
            setTimeout(trySetMapping, 10);
          }
        };
        trySetMapping();
      }
    });
  }

  // Reactive getters for config access
  get xLabel() { return this.config.xLabel; }
  get yLabel() { return this.config.yLabel; }
  get layout() { return this.config.layout; }
  get chartId() { return this.config.layout.chartId; }

  // Resolution with configuration support
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

  // Derive types from configurations for backward compatibility
  scaleTypes = $derived.by(() => ({
    x: this.scaleConfigurations?.x?.type || 'linear',
    y: this.scaleConfigurations?.y?.type || 'linear'
  }));

  // Use resolved configurations with scale states
  xScaleState = $derived(getScaleState(
    this.xLabel, 
    this.scaleConfigurations?.x?.type || 'linear',
    this.scaleConfigurations?.x?.config || {},
    this.gpuCoordinator,
    this.chartId
  ));

  yScaleState = $derived(getScaleState(
    this.yLabel, 
    this.scaleConfigurations?.y?.type || 'linear', 
    this.scaleConfigurations?.y?.config || {},
    this.gpuCoordinator,
    this.chartId
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

  // registerScaleType with configuration support
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

  // Summary now includes configuration info
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

  // NEW: Accumulation-only methods (replace applyZoom, applyPanDomain)
  accumulateZoom = (innerPoint, scaleFactor, doX, doY) => {
    // console.log('accumulateZoom', scaleFactor)
    if (doX && this.scaleTypes?.x === 'linear') {
      const dataPoint = this.xScale.scale.invert(innerPoint.x);
      this.xScaleState.accumulateZoom(dataPoint, scaleFactor);
    }
    if (doY && this.scaleTypes?.y === 'linear') {
      const dataPoint = this.yScale.scale.invert(innerPoint.y);
      this.yScaleState.accumulateZoom(dataPoint, scaleFactor);
    }
  }


  applyZoom = (innerPoint, scaleFactor, doX, doY) => {
    if (doX && this.scaleTypes?.x === 'linear') {
      const dataPoint = this.xScale.scale.invert(innerPoint.x);
      this.xScaleState.accumulateZoom(dataPoint, scaleFactor);
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
  
  startPan = (initialScreenPos, activePanX, activePanY) => {
    // Store the active flags for use during updates
    this.activePanX = activePanX;
    this.activePanY = activePanY;
    
    // Only create contexts for scales that can pan
    if (activePanX && this.scaleTypes?.x === 'linear') {
      const panContext = {
        initialScreenPos,
        initialDomain: [...this.xScaleState.domain.current],
        screenToDataRatio: (this.xScaleState.domain.current[1] - this.xScaleState.domain.current[0]) / this.layout.innerWidth,
        domainWidth: this.xScaleState.domain.current[1] - this.xScaleState.domain.current[0],
        screenDimension: this.layout.innerWidth
      };
      this.xScaleState.setPanContext(panContext);
    }
    
    if (activePanY && this.scaleTypes?.y === 'linear') {
      const panContext = {
        initialScreenPos,
        initialDomain: [...this.yScaleState.domain.current],
        screenToDataRatio: (this.yScaleState.domain.current[1] - this.yScaleState.domain.current[0]) / this.layout.innerHeight,
        domainWidth: this.yScaleState.domain.current[1] - this.yScaleState.domain.current[0],
        screenDimension: this.layout.innerHeight
      };
      this.yScaleState.setPanContext(panContext);
    }
  }

  // endPan and updatePanPosition remain the same
  endPan = () => {
    this.activePanX = false;
    this.activePanY = false;

    if (this.scaleTypes?.x === 'linear') {
      this.xScaleState.clearPanContext();
    }
    if (this.scaleTypes?.y === 'linear') {
      this.yScaleState.clearPanContext();
    }
  }

  updatePanPosition = (screenX, screenY) => {
    if (this.activePanX && this.scaleTypes?.x === 'linear') {
      this.xScaleState.updatePanPosition(screenX, 0); // Y coordinate irrelevant for X scale
    }
    if (this.activePanY && this.scaleTypes?.y === 'linear') {
      this.yScaleState.updatePanPosition(0, screenY); // X coordinate irrelevant for Y scale
    }
  }

  xCategoryPositions = $derived.by(() => {
    if (this.scaleTypes?.x !== 'band' || !this.xScale?.scale || !this.isReady) {  // ✅ Fixed
      return null;
    }
    
    const domain = this.xScaleState.effectiveDomain;
    if (!domain || domain.length === 0) return null;
    
    const positions = domain.map(category => this.xScale.scale(category));
    
    console.log(`📍 Pre-computed ${domain.length} x-category positions for "${this.xLabel}":`, {
      domain: domain.slice(0, 5),
      positions: positions.slice(0, 5).map(p => Math.round(p)),
      bandwidth: this.xScale.scale.bandwidth(), 
      chartWidth: this.innerWidth  // ✅ Direct property
    });
    
    return new Float32Array(positions);
  });
    
  yCategoryPositions = $derived.by(() => {
    // console.log('🔍 yCategoryPositions computation triggered:', {
    //   scaleType: this.scaleTypes?.y,
    //   yScale: !!this.yScale?.scale,
    //   layoutReady: this.layout?.isReady,  // ← Check this property path
    //   innerHeight: this.layout?.innerHeight,
    //   yScaleState: !!this.yScaleState,
    //   effectiveDomain: this.yScaleState?.effectiveDomain,
    //   domainLength: this.yScaleState?.effectiveDomain?.length || 0
    // });

    // Your existing conditions
    const scaleTypeCheck = this.scaleTypes?.y === 'band';
    const scaleAvailable = !!this.yScale?.scale;
    const layoutReady = !!this.layout?.isReady;  // ← This might be the issue
    
    // console.log('🔍 yCategoryPositions conditions:', {
    //   scaleTypeCheck,
    //   scaleAvailable,
    //   layoutReady,  // ← This is probably false
    //   allConditionsMet: scaleTypeCheck && scaleAvailable && layoutReady
    // });

    if (!scaleTypeCheck || !scaleAvailable || !layoutReady) {
      console.log('❌ yCategoryPositions skipped - conditions not met');
      return null;
    }
    
    const domain = this.yScaleState.effectiveDomain;
    if (!domain || domain.length === 0) {
      console.log('❌ yCategoryPositions skipped - empty domain');
      return null;
    }
    
    const positions = domain.map(category => this.yScale.scale(category));
    
    // console.log(`📍 Pre-computed ${domain.length} y-category positions:`, {
    //   domain: Array.from(domain),
    //   positions: positions.map(p => Math.round(p)),
    //   bandwidth: this.yScale.scale.bandwidth(),
    //   chartHeight: this.layout?.innerHeight
    // });
    
    return new Float32Array(positions);
  });

  categoryPositionsReady = $derived.by(() => {
    const xReady = this.scaleTypes?.x !== 'band' || this.xCategoryPositions !== null;
    const yReady = this.scaleTypes?.y !== 'band' || this.yCategoryPositions !== null;
    return xReady && yReady;
  }); 

  // Pre-computed bandwidth for hot path access
  xBandwidth = $derived.by(() => {
    if (this.scaleTypes?.x !== 'band' || !this.baseXScale || !this.layout.isReady) {
      return 0;
    }
    return this.baseXScale.bandwidth();
  });

  yBandwidth = $derived.by(() => {
    if (this.scaleTypes?.y !== 'band' || !this.baseYScale || !this.layout.isReady) {
      return 0;
    }
    return this.baseYScale.bandwidth();
  });


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
      
      get scaleConfigurations() { return coordinator.scaleConfigurations; },
      
      get xCategoryPositions() { return coordinator.xCategoryPositions; },
      // get yCategoryPositions() { return coordinator.yCategoryPositions; },
      get yCategoryPositions() { return coordinator.yCategoryPositions; },
      get categoryPositionsReady() { return coordinator.categoryPositionsReady; },
      get xBandwidth() { return coordinator.xBandwidth; },
      get yBandwidth() { return coordinator.yBandwidth; },

      registerScaleType: coordinator.registerScaleType,
      unregisterScaleType: coordinator.unregisterScaleType,
      getScaleRequirementsSummary: coordinator.getScaleRequirementsSummary
    };
  }
}