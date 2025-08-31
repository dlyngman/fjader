// src/lib/scales/LinearScaleState.svelte.js

// UPDATED imports - remove Spring, add popmotion and GPU context
import { spring } from 'popmotion';
import { getGPUContext } from '$lib/gpu';
import { scaleLinear } from 'd3-scale';
import { extent as d3Extent } from 'd3-array';

// Spring configurations for different interactions
const springConfigs = {
  default: { stiffness: 225, damping: 25, precision: 0.0001 },
  zoom: { stiffness: 225, damping: 25, precision: 0.00000001 },
  // pan: { stiffness: 250, damping: 30, precision: 0.00000001 },
  pan: { stiffness: 50, damping: 30, precision: 0.00000001 },
  reset: { stiffness: 50, damping: 15, precision: 0.0001 },
  zoomIn: { stiffness: 75, damping: 15, precision: 0.0001 }
};

export class LinearScaleState {
  id = crypto.randomUUID();
  name = $state('');

  // Keep all existing properties
  #initExtent = [];
  #extent = [];
  #extents = new Map();
  
  domainLimits = {
    min: 0,
    max: 100,
    minWidth: 1
  };
  zoomLimits = {
    max: 10,
    min: 100
  };

  // Syncing crosshair and labels for mouse position
  currentDataPoint = $state();

  // Freeze/debounce functionality
  #enableUpdates = $state(true);
  #frozenExtent = null;

  // NEW: Custom animation state (replaces Svelte Spring)
  #current = $state([0, 100]);
  #target = [0, 100];
  #velocity = [0, 0];
  #isAnimating = false;
  #lastUpdateTime = 0;

  // NEW: Frame accumulation for high-frequency input (ZOOM ONLY)
  #frameAccumulator = {
    logZoomDelta: 0,      // Single value for zoom accumulation
    zoomCenter: 0,        // Single value for zoom center
    hasZoomUpdates: false,

    panScreenX: 0,        // Latest screen X position
    panScreenY: 0,        // Latest screen Y position  
    hasPanUpdates: false
  };

  #activePanContext = null;

  #gpuCoordinator = null;

  // NEW: Current spring configuration
  #currentSpringConfig = springConfigs.default;

  #cachedPrecision = $derived.by(() => {
    const domainSize = Math.abs(this.#target[1] - this.#target[0]);
    return Math.max(this.#currentSpringConfig.precision, domainSize * 0.0001);
  });


  constructor(name, extent = [0, 100], type = 'linear', zoomLimits = [10, 100], options = {}, gpuCoordinator = null) {
    this.name = name;
    this.#initExtent = extent;
    this.#extent = extent;
    this.type = type;
    this.zoomLimits.max = zoomLimits[0];
    this.zoomLimits.min = zoomLimits[1];
    this.#gpuCoordinator = gpuCoordinator;
    this.ready = $state(false);

    // Initialize animation state
    this.#current = [...extent];
    this.#target = [...extent];

    this.zoomInEffect = {
      enabled: options.zoomInEffect ?? true,
      factor: options.zoomInFactor ?? 5,
      springConfig: options.zoomInSpringConfig ?? springConfigs.zoomIn
    };
  }

  // For future GPUCoordinator optimization
  getParentChartId() {
    // This would need to be set when the scale is created
    // For now, use the scale name as identifier
    return this.name;
  }

  // NEW: Replace Spring domain with custom getter/setter that maintains API compatibility
  get domain() {
    return {
      current: this.#current,
      target: this.#target,
      set: (newValue, options = {}) => {
        if (options.instant) {
          this.#current = [...newValue];
          this.#target = [...newValue];
          this.#velocity = [0, 0];
        } else {
          this.#target = [...newValue];
          this.#ensureAnimating();
        }
      }
    };
  }

  setReady() {
    this.ready = true;
  }

  /**
   * Enable or disable scale updates (freeze scale when disabled)
   */
  setUpdatesEnabled(enabled) {
    const wasEnabled = this.#enableUpdates;
    this.#enableUpdates = enabled;
    
    if (wasEnabled && !enabled) {
      this.#frozenExtent = [...this.#extent];
    } else if (!wasEnabled && enabled) {
      this.#frozenExtent = null;
      this.updateExtentFromExtents();
    }
  }

  get updatesEnabled() {
    return this.#enableUpdates;
  }

  get effectiveExtent() {
    return this.#enableUpdates ? this.#extent : this.#frozenExtent || this.#extent;
  }

  addMark(range, identifier) {
    let processedRange;
    
    if (range.length === 2) {
      processedRange = [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
    } else if (range.length > 2) {
      processedRange = d3Extent(range);
    } else if (range.length === 1) {
      processedRange = [range[0], range[0]];
    } else {
      return this;
    }
    
    this.#extents.set(identifier, processedRange);

    if (this.#enableUpdates) {
      this.updateExtentFromExtents();
    }

    console.log(`📊 Scale ${this.name}: addMark from ${identifier}`, {
      range,
      oldExtent: [...this.#extent],
      newExtent: [...this.#extent],
      updatesEnabled: this.#enableUpdates
    });

    return this;
  }

  removeMark(identifier) {
    if (this.#extents.has(identifier)) {
      this.#extents.delete(identifier);

      if (this.#enableUpdates) {
        this.updateExtentFromExtents();
      }
    }
    return this;
  }

  updateExtentFromExtents(nice=true) {
    if (!this.#enableUpdates) {
      return;
    }

    if (this.#extents.size === 0) {
      this.#extent = [0, 0];
      return;
    }
    
    const extents = Array.from(this.#extents.values());
    const minStart = Math.min(...extents.map(range => range[0]));
    const maxEnd = Math.max(...extents.map(range => range[1]));
    
    if (nice) {
      this.#extent = scaleLinear().domain([minStart, maxEnd]).nice(5).domain();
    } else {
      this.#extent = [minStart, maxEnd];
    }

    this.resetDomainLimits();
    this.resetZoom();
  }

  getExtents() {
    return Object.fromEntries(this.#extents);
  }

  getBaseScale(axis, innerWidthOrHeight) {
    if (axis === 'x') {
      return scaleLinear().range([0, innerWidthOrHeight])
    } else if (axis === 'y') {
      return scaleLinear().range([innerWidthOrHeight, 0])
    }
  }

  setPanContext(panContext) {
    this.#activePanContext = panContext;
    this.#ensureAnimating();
  }

  clearPanContext() {
    this.#activePanContext = null;
  }

  updatePanPosition(screenX, screenY) {
    if (this.#frameAccumulator.panScreenX !== screenX || 
        this.#frameAccumulator.panScreenY !== screenY) {
      this.#frameAccumulator.panScreenX = screenX;
      this.#frameAccumulator.panScreenY = screenY;
      this.#frameAccumulator.hasPanUpdates = true;
      this.#ensureAnimating();
    }
  }

  // NEW: Animation system methods
  #ensureAnimating() {
    if (!this.#isAnimating) {
      this.#isAnimating = true;
      // this.#lastUpdateTime = performance.now();
      this.#lastUpdateTime = 0;
      
      // console.log(`🎬 Starting animation for scale: ${this.name}`, {
      //   current: [...this.#current],
      //   target: [...this.#target],
      //   config: this.#currentSpringConfig.stiffness
      // });
      
      if (this.#gpuCoordinator) {
        this.#gpuCoordinator.addAnimatingScale(this);
      } else {
        console.warn(`⚠️ No GPU coordinator found for scale: ${this.name}`);
      }
    }
  }

  #updateSpringConfig(config) {
    this.#currentSpringConfig = config;
  }

  stepAnimation(currentTime) {
    // const deltaTime = Math.min(currentTime - this.#lastUpdateTime, 16.67);
    let deltaTime;
    if (!this.#lastUpdateTime) {
      deltaTime = 8.3;  // default first animation frame timing, alternatie to skip one frame?
      this.#lastUpdateTime = currentTime;
    } else {
      deltaTime = currentTime - this.#lastUpdateTime;
      this.#lastUpdateTime = currentTime;
    }
    
    let hasChanges = false;

    // 1. DOMAIN CALCULATION from accumulated input (ONLY place this happens!)
    if (this.#frameAccumulator.hasZoomUpdates) {
      const oldTarget = [...this.#target];
      this.#updateSpringConfig(springConfigs.zoom);
      const totalZoomFactor = Math.exp(this.#frameAccumulator.logZoomDelta);
      this.#target = this.#calculateZoomedDomain(
        this.#frameAccumulator.zoomCenter, 
        totalZoomFactor
      );
      hasChanges = true;
    }

    if (this.#frameAccumulator.hasPanUpdates && this.#activePanContext) {
      this.#updateSpringConfig(springConfigs.pan);
      this.#target = this.#calculatePanTarget(
        this.#frameAccumulator.panScreenX,
        this.#frameAccumulator.panScreenY
      );
      hasChanges = true;
    }

    // 2. Reset accumulator AFTER domain calculation
    this.#resetAccumulator();

    // 3. Physics toward target (unchanged)
    const springChanges = this.#springStep(deltaTime);
    hasChanges = hasChanges || springChanges;


    // 4. Check completion
    const isComplete = !hasChanges || this.#isAtTarget();

    if (isComplete) {
      this.#isAnimating = false;
      // console.log(`✅ Animation completed for scale: ${this.name}`);
    }

    return !isComplete;
  }

  #springStep(deltaTime) {
    const config = this.#currentSpringConfig;
    const dt = Math.min(deltaTime / 1000, 0.033);
    // const dt = deltaTime / 1000;
    // const dt = deltaTime;
    
    const distance = [
      this.#target[0] - this.#current[0],
      this.#target[1] - this.#current[1]
    ];

    if (Math.abs(distance[0]) < this.#cachedPrecision && 
        Math.abs(distance[1]) < this.#cachedPrecision &&
        Math.abs(this.#velocity[0]) < this.#cachedPrecision * 2 &&
        Math.abs(this.#velocity[1]) < this.#cachedPrecision * 2) {
      // Animation complete...
      return false;
    }
  
    
    // Rest of spring physics unchanged...
    for (let i = 0; i < 2; i++) {
      const springForce = distance[i] * config.stiffness;
      const dampingForce = -this.#velocity[i] * config.damping;
      const acceleration = springForce + dampingForce;
      
      this.#velocity[i] += acceleration * dt;
      this.#current[i] += this.#velocity[i] * dt;
    }
    
    return true;
  }

  // NEW: Check if animation is complete
  #isAtTarget() {
    const config = this.#currentSpringConfig;
    const domainSize = Math.abs(this.#target[1] - this.#target[0]);
    const dynamicPrecision = Math.max(config.precision, domainSize * 0.00001);
    
    return Math.abs(this.#current[0] - this.#target[0]) < dynamicPrecision &&
           Math.abs(this.#current[1] - this.#target[1]) < dynamicPrecision &&
           Math.abs(this.#velocity[0]) < dynamicPrecision * 10 &&
           Math.abs(this.#velocity[1]) < dynamicPrecision * 10;
  }

  // NEW: Reset frame accumulator
  #resetAccumulator() {
    this.#frameAccumulator.logZoomDelta = 0;
    this.#frameAccumulator.zoomCenter = 0;
    this.#frameAccumulator.hasZoomUpdates = false;
    this.#frameAccumulator.panScreenX = 0;
    this.#frameAccumulator.panScreenY = 0;
    this.#frameAccumulator.hasPanUpdates = false;
  }

  // Helper methods for zoom calculations
  #calculateZoomedDomain(centerPoint, scaleFactor) {
    const [min, max] = this.#target;
    const minLimit = this.domainLimits.min;
    const maxLimit = this.domainLimits.max;
    const limitWidth = maxLimit - minLimit;
    const minDomainWidth = this.domainLimits.minWidth;

    const mouseRatio = (centerPoint - min) / (max - min);
    const newDomainWidth = (max - min) / scaleFactor;
    const effectiveDomainWidth = Math.max(newDomainWidth, minDomainWidth);

    let newMin = centerPoint - (mouseRatio * effectiveDomainWidth);
    let newMax = newMin + effectiveDomainWidth;

    // Apply constraints
    if (effectiveDomainWidth > limitWidth) {
      newMin = minLimit;
      newMax = maxLimit;
    } else {
      if (newMin < minLimit) {
        newMin = minLimit;
        newMax = newMin + effectiveDomainWidth;
      }
      
      if (newMax > maxLimit) {
        newMax = maxLimit;
        newMin = newMax - effectiveDomainWidth;
        
        if (newMin < minLimit) {
          newMin = minLimit;
        }
      }
    }

    return [newMin, newMax];
  }

  #calculatePanTarget(screenX, screenY) {
    if (!this.#activePanContext) return this.#target;
    
    const { initialScreenPos, initialDomain, screenToDataRatio } = this.#activePanContext;
    
    // Calculate dataDelta directly with single conditional
    const dataDelta = screenX !== 0 
      ? -(screenX - initialScreenPos.x) * screenToDataRatio
      : (screenY - initialScreenPos.y) * screenToDataRatio;
    
    let newMin = initialDomain[0] + dataDelta;
    let newMax = initialDomain[1] + dataDelta;
    
    // Apply constraints
    const range = newMax - newMin;
    if (newMin < this.domainLimits.min) {
      newMin = this.domainLimits.min;
      newMax = newMin + range;
    } else if (newMax > this.domainLimits.max) {
      newMax = this.domainLimits.max;
      newMin = newMax - range;
      
      if (newMin < this.domainLimits.min) {
        newMin = this.domainLimits.min;
      }
    }
    return [newMin, newMax];
  }


  accumulateZoom(dataCenter, scaleFactor) {
    this.#frameAccumulator.logZoomDelta += Math.log(scaleFactor);
    this.#frameAccumulator.zoomCenter = dataCenter;
    this.#frameAccumulator.hasZoomUpdates = true;
    this.#ensureAnimating();
    // console.log('frameAccumulator', this.#frameAccumulator.logZoomDelta)
  }

  updateScaleDomain(scale, current = true) {
    const targetDomain = current ? this.#current : this.#target;
    return { scale: scale.domain(targetDomain) }
  }

  resetZoom() {
    const targetExtent = this.effectiveExtent;
    
    // Handle invalid extents
    if (targetExtent[0] === targetExtent[1] || 
        !isFinite(targetExtent[0]) || 
        !isFinite(targetExtent[1])) {
      console.warn(`⚠️ Scale ${this.name} skipping zoom - invalid extent:`, targetExtent);
      return;
    }

    if (!this.ready && this.zoomInEffect.enabled) {
      // Zoom-in effect: start expanded, animate to target
      this.#updateSpringConfig(this.zoomInEffect.springConfig);
      
      const center = (targetExtent[0] + targetExtent[1]) / 2;
      const range = targetExtent[1] - targetExtent[0];
      const expandedExtent = [
        center - (range * this.zoomInEffect.factor) / 2,
        center + (range * this.zoomInEffect.factor) / 2
      ];
      
      this.#current = [...expandedExtent];
      this.#target = [...targetExtent];
      this.#ensureAnimating();
    } else if (!this.ready) {
      // Not ready, no animation
      this.#current = [...targetExtent];
      this.#target = [...targetExtent];
    } else {
      // Normal reset with animation
      this.#updateSpringConfig(springConfigs.reset);
      this.#target = [...targetExtent];
      this.#ensureAnimating();
    }
  }

  resetDomainLimits() {
    const [min, max] = this.effectiveExtent;
    const width = max - min;

    this.domainLimits.min = min - this.zoomLimits.max * width
    this.domainLimits.max = max + this.zoomLimits.max * width
    this.domainLimits.minWidth = width / this.zoomLimits.min;
  }
      
  zoomToRange([min, max]) {
    this.#updateSpringConfig(springConfigs.default);
    this.#target = [min, max];
    this.#ensureAnimating();
  }

  #domainScaleFactor = $derived.by(() => {
    const [min, max] = this.#current;
    const range = max - min;
    return range === 0 ? 0 : 1 / range;
  });

  get gpuState() {
      const [min, max] = this.#current;

      return {
          domainMin: min,
          domainMax: max,
          categoryCount: 0,
          domainScale: this.#domainScaleFactor
      };
  }

  getDebugInfo() {
    return {
      updatesEnabled: this.#enableUpdates,
      currentExtent: [...this.#extent],
      frozenExtent: this.#frozenExtent ? [...this.#frozenExtent] : null,
      effectiveExtent: [...this.effectiveExtent],
      extentsCount: this.#extents.size,
      extents: Object.fromEntries(this.#extents),
      
      // Animation state debug info
      animationState: {
        current: [...this.#current],
        target: [...this.#target],
        velocity: [...this.#velocity],
        isAnimating: this.#isAnimating
      },
      
      springConfig: this.#currentSpringConfig,
      
      frameAccumulator: {
        logZoomDelta: this.#frameAccumulator.logZoomDelta,
        zoomCenter: this.#frameAccumulator.zoomCenter,
        hasZoomUpdates: this.#frameAccumulator.hasZoomUpdates
      }
    };
  }

  destroy() {
    this.#frozenExtent = null;
    this.#isAnimating = false;
    this.#resetAccumulator();
  }

  // TEST: Animation debugging helper
  testAnimation(gpuCoordinator) {
    console.log(`🧪 Starting test animation for scale: ${this.name}`);
    
    // Animate to a different domain and back
    const originalTarget = [...this.#target];
    const [min, max] = this.#current;
    const range = max - min;
    const testTarget = [min + range * 0.5, max + range * 0.5];
    
    // First animation: pan right
    this.#target = testTarget;
    this.#ensureAnimating();
    
    // Second animation after 1 second: return to original
    setTimeout(() => {
      this.#target = originalTarget;
      this.#ensureAnimating();
    }, 1000);
  }
}