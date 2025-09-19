import { getGPUContext } from '$lib/gpu';
import { scaleLinear } from 'd3-scale';
import { extent as d3Extent } from 'd3-array';

// Spring configurations for different interactions
const springConfigs = {
  default: { stiffness: 225, damping: 25, precision: 0.0001 },
  zoom: { stiffness: 225, damping: 25, precision: 0.00000001 },
  pan: { stiffness: 300, damping: 50, precision: 0.00000001 },
  // damping: sqrt(stiffness) * 2 for critical damping
  // pan: { stiffness: 250, damping: 30, precision: 0.00000001 },
  // pan: { stiffness: 150, damping: 15, precision: 0.00000001 },
  reset: { stiffness: 50, damping: 15, precision: 0.0001 },
  zoomIn: { stiffness: 75, damping: 15, precision: 0.0001 }
};

export class LinearScaleState {
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

  currentDataPoint = $state();
  #enableUpdates = $state(true);
  #frozenExtent = null;

  // Custom animation state
  #target = [0, 100];
  #velocity = [0, 0];
  #isAnimating = false;

  #physicsCurrent = [0, 100];
  #physicsPrevious = [0, 100];
  
  #renderCurrent = $state([0, 100]);

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

  #latestPanScreenX = 0;
  #latestPanScreenY = 0;
  #hasNewPanInput = false;

  // #inputBuffer = [];

  #activePanContext = null;

  #gpuCoordinator = null;

  // NEW: Current spring configuration
  #currentSpringConfig = springConfigs.default;

  #cachedPrecision = $derived.by(() => {
    const domainSize = Math.abs(this.#target[1] - this.#target[0]);
    return Math.max(this.#currentSpringConfig.precision, domainSize * 0.0001);
  });

  #gpuStateObject = {
    domainMin: 0,
    domainMax: 100,
    categoryCount: 0,
    domainScale: 0.01
  };


  constructor(name, extent = [0, 100], type = 'linear', zoomLimits = [10, 100], options = {}, gpuCoordinator = null) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.#initExtent = extent;
    this.#extent = extent;
    this.type = type;
    this.zoomLimits.max = zoomLimits[0];
    this.zoomLimits.min = zoomLimits[1];
    this.#gpuCoordinator = gpuCoordinator;

    // Register buffer pool with coordinator
    if (gpuCoordinator) {
      // gpuCoordinator.createBufferPoolForScale(this.id, 'linear');
      gpuCoordinator.registerScale(this.id, 'linear');
    }

    this.ready = $state(false);

    // Initialize animation state
    this.#physicsCurrent = [...extent];
    this.#physicsPrevious = [...extent];
    this.#renderCurrent = [...extent];
    this.#target = [...extent];

    const self = this;
    this.domain = {
      get current() { return self.#renderCurrent; },
      get target() { return self.#target; },
      set(newValue, options = {}) {
        if (options.instant) {
          self.#target = [...newValue];
          self.#physicsCurrent = [...newValue];
          self.#physicsPrevious = [...newValue];
          self.#renderCurrent = [...newValue];
          self.#velocity = [0, 0];
        } else {
          self.#target = [...newValue];
          self.#ensureAnimating();
        }
      }
    };

    this.zoomInEffect = {
      enabled: options.zoomInEffect ?? true,
      factor: options.zoomInFactor ?? 5,
      springConfig: options.zoomInSpringConfig ?? springConfigs.zoomIn
    };
  }

  setReady() {
    this.ready = true;
  }

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

  // updatePanPosition(screenX, screenY) {
  //   // if (this.#frameAccumulator.panScreenX !== screenX || 
  //   //     this.#frameAccumulator.panScreenY !== screenY) {
  //   //   this.#frameAccumulator.panScreenX = screenX;
  //   //   this.#frameAccumulator.panScreenY = screenY;
  //   //   this.#frameAccumulator.hasPanUpdates = true;
  //   //   this.#ensureAnimating();
  //   // }
  //   const now = performance.now();
  
  //   this.#inputBuffer.push({
  //     screenX,
  //     screenY,
  //     timestamp: now,
  //   });
    
  //   if (this.#inputBuffer.length > 10) {
  //     this.#inputBuffer.shift();
  //   }
  
  //   this.#ensureAnimating();
  // }
  updatePanPosition(screenX, screenY) {
    this.#latestPanScreenX = screenX;
    this.#latestPanScreenY = screenY;
    this.#hasNewPanInput = true;
    this.#ensureAnimating();
  }

  accumulateZoom(dataCenter, scaleFactor) {
    this.#frameAccumulator.logZoomDelta += Math.log(scaleFactor);
    this.#frameAccumulator.zoomCenter = dataCenter;
    this.#frameAccumulator.hasZoomUpdates = true;
    this.#ensureAnimating();
  }

  updateScaleDomain(scale, current = true) {
    const targetDomain = current ? this.domain.current : this.#target;
    return { scale: scale.domain(targetDomain) }
  }
  

  #ensureAnimating() {
    if (!this.#isAnimating) {
      this.#isAnimating = true;
      this.#lastUpdateTime = 0;
      
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

  #isAtTarget() {
    const config = this.#currentSpringConfig;
    const domainSize = Math.abs(this.#target[1] - this.#target[0]);
    // TODO replace this calculation with cached value?
    const dynamicPrecision = Math.max(config.precision, domainSize * 0.00001);
    
    return Math.abs(this.#physicsCurrent[0] - this.#target[0]) < dynamicPrecision &&
           Math.abs(this.#physicsCurrent[1] - this.#target[1]) < dynamicPrecision &&
           Math.abs(this.#velocity[0]) < dynamicPrecision * 10 &&
           Math.abs(this.#velocity[1]) < dynamicPrecision * 10;
  }

  #resetAccumulator() {
    this.#frameAccumulator.logZoomDelta = 0;
    this.#frameAccumulator.zoomCenter = 0;
    this.#frameAccumulator.hasZoomUpdates = false;
    this.#frameAccumulator.panScreenX = 0;
    this.#frameAccumulator.panScreenY = 0;
    this.#frameAccumulator.hasPanUpdates = false;
  }

  #calculateZoomedDomain(targetArray, centerPoint, scaleFactor) {
    // const [min, max] = this.#target;
    const [min, max] = targetArray;
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

    // return [newMin, newMax];
    targetArray[0] = newMin;
    targetArray[1] = newMax;
  }

  // _processScheduledInput(currentTime, globalDelay) {
  //   if (!this.#activePanContext || this.#inputBuffer.length === 0) {
  //     return false;
  //   }
    
  //   // Find most recent event that's ready based on global delay
  //   let readyEvent = null;
  //   let readyIndex = -1;
    
  //   for (let i = this.#inputBuffer.length - 1; i >= 0; i--) {
  //     const event = this.#inputBuffer[i];
  //     if (currentTime >= event.timestamp + globalDelay) {
  //       readyEvent = event;
  //       readyIndex = i;
  //       break;
  //     }
  //   }
    
  //   if (readyEvent) {
  //     this.#updateSpringConfig(springConfigs.pan);
  //     this.#calculatePanTarget(this.#target, readyEvent.screenX, readyEvent.screenY);
  //     this.#inputBuffer.splice(0, readyIndex + 1);
  //     return true;
  //   }
    
  //   return false;
  // }

  #calculatePanTarget(targetArray, screenX, screenY) {
    // console.trace('calculatePanTarget called');
    if (!this.#activePanContext) return // this.#target;
    
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

    // // Determine the smallest meaningful change
    // const domainSize = this.#activePanContext.domainWidth;
    // const pixelEquivalent = this.#activePanContext.domainWidth / this.#activePanContext.screenDimension;
    // const quantum = pixelEquivalent * 1;

    // const beforeQuantization = [newMin, newMax];
  
    // // Quantize to avoid micro-errors
    // newMin = Math.round(newMin / quantum) * quantum;
    // newMax = Math.round(newMax / quantum) * quantum;

    // console.log(`Quantum: ${quantum.toFixed(8)}, Before: [${beforeQuantization[0].toFixed(6)}, ${beforeQuantization[1].toFixed(6)}], After: [${newMin.toFixed(6)}, ${newMax.toFixed(6)}]`);

    // return [newMin, newMax];
    targetArray[0] = newMin;
    targetArray[1] = newMax;
  }

  _applyInput() {
    // console.trace('_applyInput called');
    let inputApplied = false;

    if (this.#frameAccumulator.hasZoomUpdates) {
      this.#updateSpringConfig(springConfigs.zoom);
      // this.#target = this.#calculateZoomedDomain(
      this.#calculateZoomedDomain(
        this.#target,
        this.#frameAccumulator.zoomCenter,
        Math.exp(this.#frameAccumulator.logZoomDelta)
      );
      inputApplied = true;
    }

    // if (this.#frameAccumulator.hasPanUpdates && this.#activePanContext) {
    //   this.#updateSpringConfig(springConfigs.pan);
    //   this.#calculatePanTarget(
    //     this.#target,
    //     this.#frameAccumulator.panScreenX,
    //     this.#frameAccumulator.panScreenY
    //   );
    //   inputApplied = true;
    // }

    // this.#resetAccumulator();

    // --- NEW Pan logic ---
    if (this.#hasNewPanInput && this.#activePanContext) {
      this.#updateSpringConfig(springConfigs.pan);
      this.#calculatePanTarget(
        this.#target,
        this.#latestPanScreenX,
        this.#latestPanScreenY
      );
      // Reset the flag immediately after processing the input for this frame.
      this.#hasNewPanInput = false;
      inputApplied = true;
    }

    // --- Cleanup ---
    // We only need to reset the zoom accumulator now.
    this.#frameAccumulator.logZoomDelta = 0;
    this.#frameAccumulator.zoomCenter = 0;
    this.#frameAccumulator.hasZoomUpdates = false;

    if (inputApplied) {
      this.#ensureAnimating();
    }
  }

  // _updatePhysics(fixedTimestep) {
  //   const dt = fixedTimestep / 1000.0;

  //   // Update internal physics state.
  //   this.#physicsPrevious[0] = this.#physicsCurrent[0];
  //   this.#physicsPrevious[1] = this.#physicsCurrent[1];

  //   if (this.#activePanContext) {
  //     // Pan: Only simulate spring for min value, calculate max from fixed width
  //     const domainWidth = this.#activePanContext.domainWidth;
      
  //     // Spring simulation only for min value
  //     const distance = this.#target[0] - this.#physicsCurrent[0];
  //     const springForce = distance * this.#currentSpringConfig.stiffness;
  //     const dampingForce = -this.#velocity[0] * this.#currentSpringConfig.damping;
  //     const acceleration = springForce + dampingForce;
      
  //     this.#velocity[0] += acceleration * dt;
  //     this.#physicsCurrent[0] += this.#velocity[0] * dt;
      
  //     // Max is simply min + width (no spring simulation needed)
  //     this.#physicsCurrent[1] = this.#physicsCurrent[0] + domainWidth;
  //     this.#velocity[1] = this.#velocity[0]; // Same velocity for rigid body

  //     // console.log(`Spring: pos=${this.#physicsCurrent[0].toFixed(6)}, vel=${this.#velocity[0].toFixed(6)}, target=${this.#target[0].toFixed(6)}`);
      
  //   } else {
  //     // Zoom: Independent springs for both min and max (needed for zoom-around-point)
  //     for (let i = 0; i < 2; i++) {
  //       const distance = this.#target[i] - this.#physicsCurrent[i];
  //       const springForce = distance * this.#currentSpringConfig.stiffness;
  //       const dampingForce = -this.#velocity[i] * this.#currentSpringConfig.damping;
  //       const acceleration = springForce + dampingForce;
        
  //       this.#velocity[i] += acceleration * dt;
  //       this.#physicsCurrent[i] += this.#velocity[i] * dt;
  //     }
  //   }

  //   // for (let i = 0; i < 2; i++) {
  //   //   const distance = this.#target[i] - this.#physicsCurrent[i];
  //   //   // ... spring math using #physicsCurrent and #velocity ...
  //   //   const springForce = distance * this.#currentSpringConfig.stiffness;
  //   //   const dampingForce = -this.#velocity[i] * this.#currentSpringConfig.damping;
  //   //   const acceleration = springForce + dampingForce;
      
  //   //   this.#velocity[i] += acceleration * dt;
  //   //   this.#physicsCurrent[i] += this.#velocity[i] * dt;
  //   // }
    
  //   if (this.#isAtTarget()) {
  //     this.#isAnimating = false;
  //     this.#gpuCoordinator.removeAnimatingScale(this);
  //   }
  // }

  _updatePhysics(deltaTime) {
    // const dt = Math.min(deltaTime, 8.333) / 1000.0; 
    const dt = deltaTime / 1000.0; // Convert to seconds
    
    if (this.#activePanContext) {
      // Pan physics - single spring for min value
      const distance = this.#target[0] - this.#physicsCurrent[0];
      const springForce = distance * this.#currentSpringConfig.stiffness;
      const dampingForce = -this.#velocity[0] * this.#currentSpringConfig.damping;
      const acceleration = springForce + dampingForce;
      
      this.#velocity[0] += acceleration * dt;
      this.#physicsCurrent[0] += this.#velocity[0] * dt;
      this.#physicsCurrent[1] = this.#physicsCurrent[0] + this.#activePanContext.domainWidth;
      this.#velocity[1] = this.#velocity[0];
    } else {
      // Zoom physics - independent springs
      for (let i = 0; i < 2; i++) {
        const distance = this.#target[i] - this.#physicsCurrent[i];
        const springForce = distance * this.#currentSpringConfig.stiffness;
        const dampingForce = -this.#velocity[i] * this.#currentSpringConfig.damping;
        const acceleration = springForce + dampingForce;
        
        this.#velocity[i] += acceleration * dt;
        this.#physicsCurrent[i] += this.#velocity[i] * dt;
      }
    }
    
    // Check if at target (same as before)
    if (this.#isAtTarget()) {
      this.#isAnimating = false;
      this.#gpuCoordinator.removeAnimatingScale(this);
    }
  }

  // _setRenderState(alpha) {
  //   this.#renderCurrent[0] = this.#physicsPrevious[0] * (1.0 - alpha) + this.#physicsCurrent[0] * alpha;
  //   // this.#renderCurrent[1] = this.#physicsPrevious[1] * (1.0 - alpha) + this.#physicsCurrent[1] * alpha;
  
  //   if (this.#activePanContext) {
  //     // Maintain rigid body constraint during interpolation
  //     this.#renderCurrent[1] = this.#renderCurrent[0] + this.#activePanContext.domainWidth;
  //   } else {
  //     this.#renderCurrent[1] = this.#physicsPrevious[1] * (1.0 - alpha) + this.#physicsCurrent[1] * alpha;
  //   }
  //   // this.#renderCurrent = [
  //     // this.#physicsPrevious[0] * (1.0 - alpha) + this.#physicsCurrent[0] * alpha,
  //     // this.#physicsPrevious[1] * (1.0 - alpha) + this.#physicsCurrent[1] * alpha
  //   // ];

  //   // console.log(`Alpha: ${alpha.toFixed(3)}, Prev: ${this.#physicsPrevious[0].toFixed(3)}, Curr: ${this.#physicsCurrent[0].toFixed(3)}, Render: ${this.#renderCurrent[0].toFixed(3)}`);

  //   // console.log(`Render state: current=${this.#renderCurrent[0].toFixed(6)}, ${this.#renderCurrent[1].toFixed(6)}`);
  //   return this.#renderCurrent[0]
  // }

  _setRenderState() {
    // No interpolation - render state IS physics state
    this.#renderCurrent[0] = this.#physicsCurrent[0];
    this.#renderCurrent[1] = this.#physicsCurrent[1];
    
    return this.#renderCurrent[0];
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

    // This is the final state we want to animate TOWARDS.
    this.#target[0] = targetExtent[0];
    this.#target[1] = targetExtent[1];
    
    if (!this.ready && this.zoomInEffect.enabled) {
      // --- Initial "Zoom-In" Effect ---
      this.#updateSpringConfig(this.zoomInEffect.springConfig);
      
      const center = (targetExtent[0] + targetExtent[1]) / 2;
      const range = targetExtent[1] - targetExtent[0];
      const expandedMin = center - (range * this.zoomInEffect.factor) / 2;
      const expandedMax = center + (range * this.zoomInEffect.factor) / 2;
      
      // Instantly set the starting physics state to the expanded view.
      this.#physicsCurrent[0] = expandedMin;
      this.#physicsCurrent[1] = expandedMax;
      this.#physicsPrevious[0] = expandedMin;
      this.#physicsPrevious[1] = expandedMax;
      this.#renderCurrent[0] = expandedMin;
      this.#renderCurrent[1] = expandedMax;
      
    } else if (!this.ready) {
      // --- Not ready, no animation ---
      // Instantly snap ALL states to the target.
      const [min, max] = targetExtent;
      this.#physicsCurrent[0] = min;
      this.#physicsCurrent[1] = max;
      this.#physicsPrevious[0] = min;
      this.#physicsPrevious[1] = max;
      this.#renderCurrent[0] = min;
      this.#renderCurrent[1] = max;
      
    } else {
      // --- Normal animated reset ---
      // This is called when the user double-clicks. The animation starts
      // from wherever the physics state currently is.
      this.#updateSpringConfig(springConfigs.reset);
    }

    // Reset velocity to ensure a smooth start and stop any current motion.
    this.#velocity = [0, 0];
    
    // Ensure the animation loop starts.
    this.#ensureAnimating();
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

  get gpuState() {
      const [min, max] = this.#renderCurrent;
      const range = max - min;

      const state = this.#gpuStateObject;
      state.domainMin = min;
      state.domainMax = max;
      // categoryCount is already 0
      state.domainScale = range === 0 ? 0 : 1 / range;

      // console.log('gpuState', state.domainMin)

      return state;
  }

  destroy() {
    this.#frozenExtent = null;
    this.#isAnimating = false;
    this.#resetAccumulator();
    this.#gpuCoordinator.unregisterScale(this.id)
  }
}