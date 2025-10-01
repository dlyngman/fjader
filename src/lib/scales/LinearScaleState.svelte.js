import { getGPUContext } from '$lib/gpu';
import { scaleLinear } from 'd3-scale';
import { extent as d3Extent } from 'd3-array';
import { PointerInputProcessor, SimplePointerProcessor } from './PointerInputProcessor.js';

// Spring configurations for different interactions
const springConfigs = {
  default: { stiffness: 225, damping: 25, precision: 0.0001 },
  zoom: { stiffness: 225, damping: 25, precision: 0.00000001 },
  pan: { stiffness: 300, damping: 40, precision: 0.00000001 },
  // pan: { stiffness: 400, damping: 40, precision: 0.00000001 },
  reset: { stiffness: 50, damping: 15, precision: 0.0001 },
  zoomIn: { stiffness: 75, damping: 15, precision: 0.0001 }
};

export class LinearScaleState {
  name = $state('');

  // Domain management
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

  // Physics state
  #target = [0, 100];
  #physicsCurrent = [0, 100];
  #physicsPrevious = [0, 100];
  #velocity = [0, 0];
  #renderCurrent = $state([0, 100]);
  
  #isAnimating = false;
  #lastUpdateTime = 0;

  // Input processing
  #inputProcessor = null;
  #activePanContext = null;

  // Zoom accumulation
  #frameAccumulator = {
    logZoomDelta: 0,
    zoomCenter: 0,
    hasZoomUpdates: false
  };

  #gpuCoordinator = null;
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

  #desiredTarget = [0, 100];    // Raw target from pointer input
  #targetVelocity = [0, 0];     // Velocity of target smoothing

  // Target smoothing spring constants (tune these for feel)
  // #TARGET_STIFFNESS = 500;
  #TARGET_STIFFNESS = 2000;
  // #TARGET_DAMPING = 50;
  #TARGET_DAMPING = 80;
  #lastLoggedDesired = 0;

  constructor(name, extent = [0, 100], type = 'linear', zoomLimits = [10, 100], options = {}, gpuCoordinator = null) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.#initExtent = extent;
    this.#extent = extent;
    this.type = type;
    this.zoomLimits.max = zoomLimits[0];
    this.zoomLimits.min = zoomLimits[1];
    this.#gpuCoordinator = gpuCoordinator;

    // Initialize input processor with tuned parameters
    this.#inputProcessor = new PointerInputProcessor();
    // this.#inputProcessor = new SimplePointerProcessor();
    // Tune for responsive tracking
    this.#inputProcessor.tauMs = 50;   // Fast response
    this.#inputProcessor.k = 1;       // Critical damping

    if (gpuCoordinator) {
      gpuCoordinator.registerScale(this.id, 'linear');
    }

    this.ready = $state(false);

    // Initialize animation state
    this.#physicsCurrent = [...extent];
    this.#physicsPrevious = [...extent];
    this.#renderCurrent = [...extent];
    this.#target = [...extent];
    this.#desiredTarget = [...extent];
    this.#targetVelocity = [0, 0];

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

  setPanContext(panContext) {
    this.#activePanContext = panContext;
    this.#updateSpringConfig(springConfigs.pan);
    this.#inputProcessor.reset();
    this.#ensureAnimating();
  }

  endPan() {
    this.#activePanContext = null;
    this.#inputProcessor.reset();
    this.#updateSpringConfig(springConfigs.default);
  }

  updatePanPositionWithCoalescing(coalescedEvents) {
    
    if (!this.#activePanContext || coalescedEvents.length === 0) return;

    for (const event of coalescedEvents) {
      this.#inputProcessor.addSample(
        event.offsetX, 
        event.offsetY, 
        event.timeStamp || performance.now()
      );
    }
    
    this.#ensureAnimating();
  }

  accumulateZoom(dataCenter, scaleFactor) {
    this.#frameAccumulator.logZoomDelta += Math.log(scaleFactor);
    this.#frameAccumulator.zoomCenter = dataCenter;
    this.#frameAccumulator.hasZoomUpdates = true;
    this.#ensureAnimating();
  }

  #ensureAnimating() {
    if (!this.#isAnimating) {
      this.#isAnimating = true;
      this.#lastUpdateTime = 0;
      
      if (this.#gpuCoordinator) {
        this.#gpuCoordinator.addAnimatingScale(this);
      }
    }
  }

  #updateSpringConfig(config) {
    this.#currentSpringConfig = config;
  }

  #isAtTarget() {
    const precision = this.#cachedPrecision;
    
    return Math.abs(this.#physicsCurrent[0] - this.#target[0]) < precision &&
           Math.abs(this.#physicsCurrent[1] - this.#target[1]) < precision &&
           Math.abs(this.#velocity[0]) < precision * 10 &&
           Math.abs(this.#velocity[1]) < precision * 10;
  }

  #calculateZoomedDomain(targetArray, centerPoint, scaleFactor) {
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

    targetArray[0] = newMin;
    targetArray[1] = newMax;
  }

  #calculatePanTarget(targetArray, screenX, screenY) {
    if (!this.#activePanContext) return;
    
    const { initialScreenPos, initialDomain, screenToDataRatio } = this.#activePanContext;
    
    const dataDelta = screenX !== 0 
      ? -(screenX - initialScreenPos.x) * screenToDataRatio
      : (screenY - initialScreenPos.y) * screenToDataRatio;

    console.log('calculatePanTarget:', {
      screenX,
      screenY,
      initialScreenPos,
      whichBranch: screenX !== 0 ? 'X' : 'Y',
      screenDelta: screenX !== 0 ? (screenX - initialScreenPos.x) : (screenY - initialScreenPos.y),
      dataDelta,
      screenToDataRatio,
      oldDomain: [...initialDomain],
      newMin: initialDomain[0] + dataDelta,
      newMax: initialDomain[1] + dataDelta
    });
    
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

    targetArray[0] = newMin;
    targetArray[1] = newMax;
  }

  // _applyInput(now) {
  //   let inputApplied = false;

  //   // Handle zoom accumulation
  //   if (this.#frameAccumulator.hasZoomUpdates) {
  //     this.#updateSpringConfig(springConfigs.zoom);
  //     this.#calculateZoomedDomain(
  //       this.#target,
  //       this.#frameAccumulator.zoomCenter,
  //       Math.exp(this.#frameAccumulator.logZoomDelta)
  //     );
  //     inputApplied = true;
      
  //     // Reset zoom accumulator
  //     this.#frameAccumulator.logZoomDelta = 0;
  //     this.#frameAccumulator.zoomCenter = 0;
  //     this.#frameAccumulator.hasZoomUpdates = false;
  //   }

  //   // Handle pan with input processor
  //   if (this.#activePanContext) {
  //     const axis = this.#activePanContext.axis;
  //     // const estimate = this.#inputProcessor.updateEstimate(now, axis);
  //     const estimate = this.#inputProcessor.getPosition(now, axis);

  //     if (estimate && estimate.confidence > 0.3) {
  //       if (axis === 'x') {
  //         this.#calculatePanTarget(this.#target, estimate.cursorPosition, 0);
  //       } else {
  //         this.#calculatePanTarget(this.#target, 0, estimate.cursorPosition);
  //       }
  //       console.log('New target:', this.#target);
  //       inputApplied = true;
  //     }
  //   }

  //   if (inputApplied) {
  //     this.#ensureAnimating();
  //   }
  // }

  _applyInput(now) {
    let inputApplied = false;

    // Handle zoom accumulation
    if (this.#frameAccumulator.hasZoomUpdates) {
      this.#updateSpringConfig(springConfigs.zoom);
      
      // CHANGED: Update both target and desired target for zoom
      this.#calculateZoomedDomain(
        this.#desiredTarget,  // Changed from this.#target
        this.#frameAccumulator.zoomCenter,
        Math.exp(this.#frameAccumulator.logZoomDelta)
      );
      
      // NEW: Snap target immediately for zoom (no smoothing delay)
      this.#target[0] = this.#desiredTarget[0];
      this.#target[1] = this.#desiredTarget[1];
      this.#targetVelocity = [0, 0];
      
      inputApplied = true;
      
      // Reset zoom accumulator
      this.#frameAccumulator.logZoomDelta = 0;
      this.#frameAccumulator.zoomCenter = 0;
      this.#frameAccumulator.hasZoomUpdates = false;
    }

    // Handle pan with input processor
    if (this.#activePanContext) {
      const axis = this.#activePanContext.axis;
      const estimate = this.#inputProcessor.getPosition(now, axis);

      if (estimate && estimate.confidence > 0.3) {
        // CHANGED: Update desiredTarget, not target
        if (axis === 'x') {
          this.#calculatePanTarget(this.#desiredTarget, estimate.cursorPosition, 0);
        } else {
          this.#calculatePanTarget(this.#desiredTarget, 0, estimate.cursorPosition);
        }
        inputApplied = true;
      }
    }

    if (inputApplied) {
      this.#ensureAnimating();
    }
  }

  _capturePhysicsStateForInterpolation() {
    this.#physicsPrevious[0] = this.#physicsCurrent[0];
    this.#physicsPrevious[1] = this.#physicsCurrent[1];
  }

  // _updatePhysics(fixedTimestep) {
  //   const dt = fixedTimestep / 1000.0;

  //   if (this.#activePanContext) {
  //     // Pan: Only simulate spring for min value, calculate max from fixed width
  //     const domainWidth = this.#activePanContext.domainWidth;
      
  //     const distance = this.#target[0] - this.#physicsCurrent[0];
  //     const springForce = distance * this.#currentSpringConfig.stiffness;
  //     const dampingForce = -this.#velocity[0] * this.#currentSpringConfig.damping;
  //     const acceleration = springForce + dampingForce;
      
  //     this.#velocity[0] += acceleration * dt;
  //     this.#physicsCurrent[0] += this.#velocity[0] * dt;
      
  //     // Rigid body: max follows min
  //     this.#physicsCurrent[1] = this.#physicsCurrent[0] + domainWidth;
  //     this.#velocity[1] = this.#velocity[0];
      
  //   } else {
  //     // Zoom: Independent springs for both min and max
  //     for (let i = 0; i < 2; i++) {
  //       const distance = this.#target[i] - this.#physicsCurrent[i];
  //       const springForce = distance * this.#currentSpringConfig.stiffness;
  //       const dampingForce = -this.#velocity[i] * this.#currentSpringConfig.damping;
  //       const acceleration = springForce + dampingForce;
        
  //       this.#velocity[i] += acceleration * dt;
  //       this.#physicsCurrent[i] += this.#velocity[i] * dt;
  //     }
  //   }
    
  //   if (this.#isAtTarget()) {
  //     this.#isAnimating = false;
  //     this.#gpuCoordinator.removeAnimatingScale(this);
  //   }
  // }

  _updatePhysics(fixedTimestep) {
    const dt = fixedTimestep / 1000.0;

    // NEW: First layer - smooth the target towards desired target
    if (this.#activePanContext) {
      // Pan: rigid body constraint for target smoothing
      const domainWidth = this.#activePanContext.domainWidth;
      
      const targetError = this.#desiredTarget[0] - this.#target[0];
      const targetSpringForce = targetError * this.#TARGET_STIFFNESS;
      const targetDampingForce = -this.#targetVelocity[0] * this.#TARGET_DAMPING;
      const targetAccel = targetSpringForce + targetDampingForce;
      
      this.#targetVelocity[0] += targetAccel * dt;
      this.#target[0] += this.#targetVelocity[0] * dt;
      
      // Max follows min rigidly
      this.#target[1] = this.#target[0] + domainWidth;
      this.#targetVelocity[1] = this.#targetVelocity[0];
      
    } else {
      // Zoom: independent springs for target smoothing
      for (let i = 0; i < 2; i++) {
        const targetError = this.#desiredTarget[i] - this.#target[i];
        const targetSpringForce = targetError * this.#TARGET_STIFFNESS;
        const targetDampingForce = -this.#targetVelocity[i] * this.#TARGET_DAMPING;
        const targetAccel = targetSpringForce + targetDampingForce;
        
        this.#targetVelocity[i] += targetAccel * dt;
        this.#target[i] += this.#targetVelocity[i] * dt;
      }
    }

    if (this.#activePanContext) {
      const desiredJump = Math.abs(this.#desiredTarget[0] - (this.#lastLoggedDesired || this.#desiredTarget[0]));
      const targetToDesiredGap = Math.abs(this.#target[0] - this.#desiredTarget[0]);
      const targetVelMag = Math.abs(this.#targetVelocity[0]);
      
      console.log('Target smoothing:', {
        desiredJump: desiredJump.toFixed(4),
        gap: targetToDesiredGap.toFixed(4),
        targetVel: targetVelMag.toFixed(4),
        domainPos: this.#target[0].toFixed(4)
      });
      
      this.#lastLoggedDesired = this.#desiredTarget[0];
    }

    // EXISTING: Second layer - display spring tracks smoothed target
    if (this.#activePanContext) {
      // Pan: rigid body constraint for display spring
      const domainWidth = this.#activePanContext.domainWidth;
      
      const distance = this.#target[0] - this.#physicsCurrent[0];
      const springForce = distance * this.#currentSpringConfig.stiffness;
      const dampingForce = -this.#velocity[0] * this.#currentSpringConfig.damping;
      const acceleration = springForce + dampingForce;
      
      this.#velocity[0] += acceleration * dt;
      this.#physicsCurrent[0] += this.#velocity[0] * dt;
      
      this.#physicsCurrent[1] = this.#physicsCurrent[0] + domainWidth;
      this.#velocity[1] = this.#velocity[0];
      
    } else {
      // Zoom: independent springs for display spring
      for (let i = 0; i < 2; i++) {
        const distance = this.#target[i] - this.#physicsCurrent[i];
        const springForce = distance * this.#currentSpringConfig.stiffness;
        const dampingForce = -this.#velocity[i] * this.#currentSpringConfig.damping;
        const acceleration = springForce + dampingForce;
        
        this.#velocity[i] += acceleration * dt;
        this.#physicsCurrent[i] += this.#velocity[i] * dt;
      }
    }
    
    // MODIFIED: Check if both springs are settled
    const precision = this.#cachedPrecision;
    
    const physicsSettled = 
      Math.abs(this.#physicsCurrent[0] - this.#target[0]) < precision &&
      Math.abs(this.#physicsCurrent[1] - this.#target[1]) < precision &&
      Math.abs(this.#velocity[0]) < precision * 10 &&
      Math.abs(this.#velocity[1]) < precision * 10;
      
    const targetSettled = 
      Math.abs(this.#target[0] - this.#desiredTarget[0]) < precision &&
      Math.abs(this.#target[1] - this.#desiredTarget[1]) < precision &&
      Math.abs(this.#targetVelocity[0]) < precision * 10 &&
      Math.abs(this.#targetVelocity[1]) < precision * 10;
    
    if (physicsSettled && targetSettled) {
      this.#isAnimating = false;
      this.#gpuCoordinator.removeAnimatingScale(this);
    }

    if (this.#activePanContext) {
      const physicsToTargetGap = Math.abs(this.#physicsCurrent[0] - this.#target[0]);
      const physicsVelMag = Math.abs(this.#velocity[0]);
      
      console.log('Display spring:', {
        gap: physicsToTargetGap.toFixed(4),
        velocity: physicsVelMag.toFixed(4),
        physicsCurrent: this.#physicsCurrent[0].toFixed(4)
      });
    }
  }

  _setRenderState(alpha) {
    const before = this.#renderCurrent[0];
    const prev0 = this.#physicsPrevious[0];
    const curr0 = this.#physicsCurrent[0];
    const delta = Math.abs(curr0 - prev0);
    
    if (delta > 1.0) {
      console.warn('Large physics delta detected:', {
        previous: prev0.toFixed(4),
        current: curr0.toFixed(4),
        delta: delta.toFixed(4),
        alpha: alpha.toFixed(3)
      });
    }

    this.#renderCurrent[0] = this.#physicsPrevious[0] * (1.0 - alpha) + this.#physicsCurrent[0] * alpha;
  
    if (this.#activePanContext) {
      // Maintain rigid body constraint during interpolation
      this.#renderCurrent[1] = this.#renderCurrent[0] + this.#activePanContext.domainWidth;
    } else {
      this.#renderCurrent[1] = this.#physicsPrevious[1] * (1.0 - alpha) + this.#physicsCurrent[1] * alpha;
    }
    const renderJump = Math.abs(this.#renderCurrent[0] - before);
    if (renderJump > 0.01) {
      console.log('Render jump:', {
        jump: renderJump.toFixed(4),
        alpha: alpha.toFixed(3),
        renderPos: this.#renderCurrent[0].toFixed(4)
      });
    }
  }

  // Svelte's exact tick_spring function
  #tickSpring(ctx, last_value, current_value, target_value) {
    const delta = target_value - current_value;
    const velocity = (current_value - last_value) / (ctx.dt || 1 / 60);

    // if (this.#activePanContext && Math.abs(delta) > 0.001) {
    //   console.log('Pan spring:', {
    //     delta: delta.toFixed(6),
    //     velocity: velocity.toFixed(6),
    //     dt: ctx.dt.toFixed(3),
    //     stiffness: ctx.opts.stiffness,
    //     damping: ctx.opts.damping
    //   });
    // }

    const spring = ctx.opts.stiffness * delta;
    const damper = ctx.opts.damping * velocity;
    const acceleration = (spring - damper) * ctx.inv_mass;
    const d = (velocity + acceleration) * ctx.dt;
    
    if (Math.abs(d) < ctx.opts.precision && Math.abs(delta) < ctx.opts.precision) {
      return target_value; // settled
    } else {
      ctx.settled = false; // signal to keep animating
      return current_value + d;
    }
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
    
    this.#desiredTarget[0] = targetExtent[0];
    this.#desiredTarget[1] = targetExtent[1];
    this.#targetVelocity = [0, 0];

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

  updateScaleDomain(scale, current = true) {
    const targetDomain = current ? this.domain.current : this.#target;
    return { scale: scale.domain(targetDomain) }
  }

  getBaseScale(axis, innerWidthOrHeight) {
    if (axis === 'x') {
      return scaleLinear().range([0, innerWidthOrHeight])
    } else if (axis === 'y') {
      return scaleLinear().range([innerWidthOrHeight, 0])
    }
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
    // this.#resetAccumulator();
    this.#gpuCoordinator.unregisterScale(this.id)
  }
}