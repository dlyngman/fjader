import { getGPUContext } from '$lib/gpu';
import { scaleLinear } from 'd3-scale';
import { extent as d3Extent } from 'd3-array';

// Spring configurations for different interactions
// const springConfigs = {
//   default: { stiffness: 225, damping: 25, precision: 0.0001 },
//   zoom: { stiffness: 225, damping: 25, precision: 0.00000001 },
//   pan: { stiffness: 300, damping: 50, precision: 0.00000001 },
//   // pan: { stiffness: 50, damping: 15, precision: 0.001 },
//   // damping: sqrt(stiffness) * 2 for critical damping
//   // pan: { stiffness: 250, damping: 30, precision: 0.00000001 },
//   // pan: { stiffness: 150, damping: 15, precision: 0.00000001 },
//   reset: { stiffness: 50, damping: 15, precision: 0.0001 },
//   zoomIn: { stiffness: 75, damping: 15, precision: 0.0001 }
// };
const springConfigs = {
  default: { stiffness: 0.2, damping: 0.8, precision: 0.001 },
  zoom: { stiffness: 0.15, damping: 0.8, precision: 0.001 },
  pan: { stiffness: 0.25, damping: 0.9, precision: 0.001 },
  reset: { stiffness: 0.1, damping: 0.85, precision: 0.001 },
  zoomIn: { stiffness: 0.05, damping: 0.8, precision: 0.001 }
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

  // --- Core Animation State ---
  #target = [0, 100];
  #physicsCurrent = [0, 100];
  #physicsPrevious = [0, 100];
  #velocity = [0, 0]; // The spring's internal velocity
  #isAnimating = false;
  #renderCurrent = $state([0, 100]);

  // --- Zoom Accumulation ---
  #frameAccumulator = { logZoomDelta: 0, zoomCenter: 0, hasZoomUpdates: false };

  // --- Input & Panning State ---
  #inputRingBuffer = [];
  #maxRingBufferSize = 100;
  #jitterBufferMs = 8;
  #panVelocity = 0; // The smoothed velocity of the pan in data units per second.
  #activePanContext = null;

  // --- Physics Tuning Parameters ---
  #panVelocitySmoothingFactor;
  #panMomentumFactor;
  #momentumBoundaryDamping;
  #boundaryResistanceFactor;

  // Custom animation state
  #smoothedTarget = [0, 100];
  

  #lastUpdateTime = 0;

  // // NEW: Frame accumulation for high-frequency input (ZOOM ONLY)
  // #frameAccumulator = {
  //   logZoomDelta: 0,      // Single value for zoom accumulation
  //   zoomCenter: 0,        // Single value for zoom center
  //   hasZoomUpdates: false,

  //   panScreenX: 0,        // Latest screen X position
  //   panScreenY: 0,        // Latest screen Y position  
  //   hasPanUpdates: false
  // };

  #rawPanScreenX = 0;
  #rawPanScreenY = 0;
  #hasNewPanInput = false;

  #inverseMass = 1;
  #momentum = 0;

  // Input history buffer for this scale's dimension
  #inputHistory = [];
  #maxHistoryMs = 100; // Keep 100ms of input history  

  #inputVelocity

  // Velocity tracking for this dimension
  #currentVelocity = 0;

  // #inputVelocity

  // remove after debugging
  // #lastTargetForLogging = 0;
  // lastInputTime = 0;


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


  constructor(name, extent = [0, 100], type = 'linear', zoomLimits = [10, 100], options = {}, gpuCoordinator = null) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.#initExtent = extent;
    this.#extent = extent;
    this.type = type;
    this.zoomLimits.max = zoomLimits[0];
    this.zoomLimits.min = zoomLimits[1];
    this.#gpuCoordinator = gpuCoordinator;

    this.#panVelocitySmoothingFactor = 0.15;
    this.#panMomentumFactor = 0.93;
    this.#momentumBoundaryDamping = 0.4;
    this.#boundaryResistanceFactor = 4.0;
    // this.#inputVelocity = 0; // Initialize to 0

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
    this.#smoothedTarget = [...extent];
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

  // setPanContext(panContext) {
  //   this.#activePanContext = panContext;
  //   this.#ensureAnimating();
  // }

  setPanContext(panContext) {
    this.#activePanContext = panContext;
    this.#updateSpringConfig(springConfigs.pan);
    this.#panVelocity = 0;
    this.#velocity = [0, 0]; // Kill any existing momentum
    this.#inputRingBuffer = []; // Clear history on new pan
    this.#ensureAnimating();
  }

  endPan() {
    if (!this.#activePanContext) return;
    const momentum = this.#panVelocity * (1 / 60);
    this.#velocity = [momentum, momentum];
    this.#panVelocity = 0;
    this.#activePanContext = null;
    this.#updateSpringConfig(springConfigs.default);
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
  // updatePanPosition(screenX, screenY) {
  //   this.#latestPanScreenX = screenX;
  //   this.#latestPanScreenY = screenY;
  //   this.#hasNewPanInput = true;
  //   this.#ensureAnimating();
  // }
  // updatePanPosition(screenX, screenY) {
  //   if (this.#activePanContext) {
  //       this.#updateSpringConfig(springConfigs.pan);
  //       this.#calculatePanTarget(this.#target, screenX, screenY);
  //       this.#ensureAnimating();
  //   }
  // }

  // Add input smoothing in updatePanPosition
  // updatePanPosition(screenX, screenY) {
  //   if (this.#activePanContext) {
  //     // Calculate raw target
  //     const rawTarget = [0, 0];
  //     this.#calculatePanTarget(rawTarget, screenX, screenY);
      
  //     // Smooth the target using exponential moving average
  //     const smoothingFactor = 0.1; // Adjust for responsiveness vs smoothness
  //     this.#target[0] = this.#target[0] * (1 - smoothingFactor) + rawTarget[0] * smoothingFactor;
  //     this.#target[1] = this.#target[1] * (1 - smoothingFactor) + rawTarget[1] * smoothingFactor;
      
  //     this.#updateSpringConfig(springConfigs.pan);
  //     this.#ensureAnimating();
  //   }
  // }

  // Store samples with consistent format
  #addInputSample(screenX, screenY, timestamp) {
    this.#inputRingBuffer.push({
      t: timestamp,
      screenX,
      screenY
    });
    
    // Trim old samples
    if (this.#inputRingBuffer.length > this.#maxRingBufferSize) {
      this.#inputRingBuffer.shift();
    }
    
    // Also trim by time
    const cutoffTime = timestamp - 200; // Keep 200ms of history
    while (this.#inputRingBuffer.length > 0 && 
          this.#inputRingBuffer[0].t < cutoffTime) {
      this.#inputRingBuffer.shift();
    }
  }


  updatePanPosition(screenX, screenY) { // Renamed back for clarity
    this.#rawPanScreenX = screenX;
    this.#rawPanScreenY = screenY;
    this.#hasNewPanInput = true;
    this.#ensureAnimating();
  }

  // updatePanPositionWithCoalescing(coalescedEvents) {
    
  //   // TODO remove debug block
  //   const now = performance.now();
  //   const timeSinceLast = now - this.lastInputTime;
  //   this.lastInputTime = now;
    
  //   console.log(`RAW_INPUT: count=${coalescedEvents.length}, dt=${timeSinceLast.toFixed(2)}ms`);

  //   // Store full coordinate pairs since this scale could be x or y axis in different charts
  //   coalescedEvents.forEach(event => {
  //     const inputSample = {
  //       screenX: event.offsetX,
  //       screenY: event.offsetY,
  //       timestamp: event.timeStamp || performance.now()
  //     };

  //     this.#inputHistory.push(inputSample);
  //   });

  //   // Trim old entries
  //   const cutoffTime = performance.now() - this.#maxHistoryMs;
  //   while (this.#inputHistory.length > 0 && this.#inputHistory[0].timestamp < cutoffTime) {
  //     this.#inputHistory.shift();
  //   }

  //   // Update velocity estimate (using whichever coordinate is being used for panning)
  //   this.#updateVelocityEstimate();

  //   this.#ensureAnimating();
  // }

  updatePanPositionWithCoalescing(coalescedEvents) {
    if (!this.#activePanContext || coalescedEvents.length === 0) return;
    coalescedEvents.forEach(event => {
      this.#addInputSample(event.offsetX, event.offsetY, event.timeStamp);
    });
    this.#ensureAnimating();
  }

  // Velocity estimation from input history
  #updateVelocityEstimate() {
    if (this.#inputHistory.length < 2) return;

    const latest = this.#inputHistory[this.#inputHistory.length - 1];
    const previous = this.#inputHistory[Math.max(0, this.#inputHistory.length - 3)];
    
    const dt = latest.timestamp - previous.timestamp;
    if (dt > 0) {
      // Calculate velocity for whichever coordinate is being used
      // The scale doesn't know which axis it represents, so this is just for diagnostic purposes
      const deltaX = latest.screenX - previous.screenX;
      const deltaY = latest.screenY - previous.screenY;
      const magnitude = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      this.#currentVelocity = magnitude / dt;
    }
  }

  #interpolateInputAtTime(targetTime) {
    if (this.#inputHistory.length === 0) return null;

    // Find samples that bracket the target time
    let beforeSample = null;
    let afterSample = null;

    for (let i = 0; i < this.#inputHistory.length; i++) {
      const sample = this.#inputHistory[i];
      
      if (sample.timestamp <= targetTime) {
        beforeSample = sample;
      } else {
        afterSample = sample;
        break;
      }
    }

    // Use closest available if we don't have bracketing samples
    if (!beforeSample && afterSample) return afterSample;
    if (beforeSample && !afterSample) return beforeSample;
    if (!beforeSample && !afterSample) return null;

    // Linear interpolation for both coordinates
    const totalDt = afterSample.timestamp - beforeSample.timestamp;
    if (totalDt === 0) return beforeSample;

    const alpha = (targetTime - beforeSample.timestamp) / totalDt;
    
    return {
      screenX: beforeSample.screenX + alpha * (afterSample.screenX - beforeSample.screenX),
      screenY: beforeSample.screenY + alpha * (afterSample.screenY - beforeSample.screenY),
      timestamp: targetTime
    };
  }

  #resampleAt(targetTime) {
    if (this.#inputRingBuffer.length < 2) return null;
    
    // Find samples that bracket the target time
    let beforeSample = null;
    let afterSample = null;
    
    for (let i = 0; i < this.#inputRingBuffer.length; i++) {
      const sample = this.#inputRingBuffer[i];
      if (sample.t <= targetTime) {
        beforeSample = sample;
      } else {
        afterSample = sample;
        break;
      }
    }
    
    // Use most recent if we don't have bracketing samples
    if (!beforeSample && afterSample) beforeSample = afterSample;
    if (beforeSample && !afterSample) afterSample = beforeSample;
    if (!beforeSample && !afterSample) return null;
    
    // Linear interpolation
    if (beforeSample === afterSample) {
      return {
        screenX: beforeSample.screenX,
        screenY: beforeSample.screenY,
        velocityX: 0,
        velocityY: 0
      };
    }
    
    const dt = afterSample.t - beforeSample.t;
    const alpha = Math.min(1, Math.max(0, (targetTime - beforeSample.t) / dt));
    
    const interpolatedX = beforeSample.screenX + alpha * (afterSample.screenX - beforeSample.screenX);
    const interpolatedY = beforeSample.screenY + alpha * (afterSample.screenY - beforeSample.screenY);
    
    // Calculate velocity (screen pixels per millisecond)
    const velocityX = (afterSample.screenX - beforeSample.screenX) / dt;
    const velocityY = (afterSample.screenY - beforeSample.screenY) / dt;
    
    return {
      screenX: interpolatedX,
      screenY: interpolatedY,
      velocityX,
      velocityY
    };
  }

  // updateRawPanInput(screenX, screenY) {
  //   this.#rawPanScreenX = screenX;
  //   this.#rawPanScreenY = screenY;
  //   this.#hasNewPanInput = true;
  //   this.#ensureAnimating();
  // }

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

  // #isAtTarget() {
  //   const config = this.#currentSpringConfig;
  //   const domainSize = Math.abs(this.#target[1] - this.#target[0]);
  //   // TODO replace this calculation with cached value?
  //   const dynamicPrecision = Math.max(config.precision, domainSize * 0.00001);
    
  //   return Math.abs(this.#physicsCurrent[0] - this.#target[0]) < dynamicPrecision &&
  //          Math.abs(this.#physicsCurrent[1] - this.#target[1]) < dynamicPrecision &&
  //          Math.abs(this.#velocity[0]) < dynamicPrecision * 10 &&
  //          Math.abs(this.#velocity[1]) < dynamicPrecision * 10;
  // }

  // #isAtTarget() {
  //   const precision = this.#cachedPrecision;
    
  //   if (this.#activePanContext) {
  //     // For pan, only check min value (max follows rigidly)
  //     const distance = Math.abs(this.#target[0] - this.#physicsCurrent[0]);
  //     return distance < precision;
  //   } else {
  //     // For zoom, check both min and max
  //     const distance0 = Math.abs(this.#target[0] - this.#physicsCurrent[0]);
  //     const distance1 = Math.abs(this.#target[1] - this.#physicsCurrent[1]);
  //     return distance0 < precision && distance1 < precision;
  //   }
  // }

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

  // _applyInput() {
  //   // console.trace('_applyInput called');
  //   let inputApplied = false;

  //   if (this.#frameAccumulator.hasZoomUpdates) {
  //     this.#updateSpringConfig(springConfigs.zoom);
  //     // this.#target = this.#calculateZoomedDomain(
  //     this.#calculateZoomedDomain(
  //       this.#target,
  //       this.#frameAccumulator.zoomCenter,
  //       Math.exp(this.#frameAccumulator.logZoomDelta)
  //     );
  //     this.#smoothedTarget[0] = this.#target[0];
  //     this.#smoothedTarget[1] = this.#target[1];
  //     inputApplied = true;
  //   }

  //   if (this.#hasNewPanInput && this.#activePanContext) {
  //     this.#updateSpringConfig(springConfigs.pan);
      
  //     // Calculate raw target from latest mouse input
  //     this.#calculatePanTarget(this.#target, this.#rawPanScreenX, this.#rawPanScreenY);
  //     this.#hasNewPanInput = false;
  //     inputApplied = true;
  //   }

  //   // if (this.#frameAccumulator.hasPanUpdates && this.#activePanContext) {
  //   //   this.#updateSpringConfig(springConfigs.pan);
  //   //   this.#calculatePanTarget(
  //   //     this.#target,
  //   //     this.#frameAccumulator.panScreenX,
  //   //     this.#frameAccumulator.panScreenY
  //   //   );
  //   //   inputApplied = true;
  //   // }

  //   // this.#resetAccumulator();

  //   // --- NEW Pan logic ---
  //   // if (this.#hasNewPanInput && this.#activePanContext) {
  //   //   this.#updateSpringConfig(springConfigs.pan);
  //   //   this.#calculatePanTarget(
  //   //     this.#target,
  //   //     this.#latestPanScreenX,
  //   //     this.#latestPanScreenY
  //   //   );
  //   //   // Reset the flag immediately after processing the input for this frame.
  //   //   this.#hasNewPanInput = false;
  //   //   inputApplied = true;
  //   // }

  //   // --- Cleanup ---
  //   // We only need to reset the zoom accumulator now.
  //   this.#frameAccumulator.logZoomDelta = 0;
  //   this.#frameAccumulator.zoomCenter = 0;
  //   this.#frameAccumulator.hasZoomUpdates = false;

  //   if (inputApplied) {
  //     this.#ensureAnimating();
  //   }
  // }

  // _applyInput(now) {
  //   let inputApplied = false;

  //   // Handle zoom accumulation (unchanged)
  //   if (this.#frameAccumulator.hasZoomUpdates) {
  //     this.#updateSpringConfig(springConfigs.zoom);
  //     this.#calculateZoomedDomain(
  //       this.#target,
  //       this.#frameAccumulator.zoomCenter,
  //       Math.exp(this.#frameAccumulator.logZoomDelta)
  //     );
  //     this.#smoothedTarget[0] = this.#target[0];
  //     this.#smoothedTarget[1] = this.#target[1];
  //     inputApplied = true;
  //   }

  //   // Use jitter-buffered pan input if available
  //   if (this.#activePanContext && this.#inputHistory.length > 0) {
  //     this.#updateSpringConfig(springConfigs.pan);
      
  //     // Get input from jitterBufferMs ago for stability
  //     const targetTime = now - this.#jitterBufferMs;
  //     const bufferedInput = this.#interpolateInputAtTime(targetTime);
      
  //     if (bufferedInput) {
  //       // For LinearScaleState, we only care about one coordinate
  //       // Pass it as screenX, with screenY as 0 (ignored by calculatePanTarget)
  //       this.#calculatePanTarget(this.#target, bufferedInput.screenX, bufferedInput.screenY);
  //       inputApplied = true;

  //       // TODO remove debuggin
  //       if (this.#lastTargetForLogging !== 0) {
  //         const targetDelta = this.#target[0] - this.#lastTargetForLogging;
  //         console.warn(`  TARGET_DELTA: ${targetDelta.toFixed(6)}`);
  //       }
  //       this.#lastTargetForLogging = this.#target[0];
  //     }
  //   } else if (this.#activePanContext && this.#hasNewPanInput) {
  //     // Fallback to raw input for backward compatibility
  //     this.#updateSpringConfig(springConfigs.pan);
  //     this.#calculatePanTarget(this.#target, this.#rawPanScreenX, this.#rawPanScreenY);
  //     this.#hasNewPanInput = false;
  //     inputApplied = true;
  //   }

  //   // Reset zoom accumulator
  //   this.#frameAccumulator.logZoomDelta = 0;
  //   this.#frameAccumulator.zoomCenter = 0;
  //   this.#frameAccumulator.hasZoomUpdates = false;

  //   if (inputApplied) {
  //     this.#ensureAnimating();
  //   }
  // }

  _applyInput(now) {
    let inputApplied = false;

    //  Handle zoom accumulation
    if (this.#frameAccumulator.hasZoomUpdates) {
      this.#updateSpringConfig(springConfigs.zoom);
      this.#calculateZoomedDomain(
        this.#target,
        this.#frameAccumulator.zoomCenter,
        Math.exp(this.#frameAccumulator.logZoomDelta)
      );
      // this.#smoothedTarget[0] = this.#target[0];
      // this.#smoothedTarget[1] = this.#target[1];
      inputApplied = true;
    }

    // --- Handle Pan Velocity Calculation ---
    if (this.#activePanContext && this.#inputRingBuffer.length > 1) {
      const sampleTime = now - this.#jitterBufferMs;
      const resampledPoint = this.#resampleAt(sampleTime);
      
      if (resampledPoint) {
        const { screenToDataRatio } = this.#activePanContext;
        
        const screenVelocity = this.#activePanContext.activePanX
          ? resampledPoint.velocityX
          : resampledPoint.velocityY;
        
        const dataVelocity = -screenVelocity * screenToDataRatio * 1000; // data units per second
        
        // Smooth the clean, resampled velocity.
        this.#panVelocity += (dataVelocity - this.#panVelocity) * this.#panVelocitySmoothingFactor;
      }
    } else if (this.#activePanContext) {
      // If there's no new input, the velocity should decay.
      this.#panVelocity *= 0.9; // Decay factor
    }

    // Reset zoom accumulator
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

  // _updatePhysics(deltaTime) {
  //   // const dt = Math.min(deltaTime, 8.333) / 1000.0; 
  //   const dt = deltaTime / 1000.0; // Convert to seconds
    
  //   if (this.#activePanContext) {
  //     // Pan physics - single spring for min value
  //     const distance = this.#target[0] - this.#physicsCurrent[0];
  //     const springForce = distance * this.#currentSpringConfig.stiffness;
  //     const dampingForce = -this.#velocity[0] * this.#currentSpringConfig.damping;
  //     const acceleration = springForce + dampingForce;
      
  //     this.#velocity[0] += acceleration * dt;
  //     this.#physicsCurrent[0] += this.#velocity[0] * dt;
  //     this.#physicsCurrent[1] = this.#physicsCurrent[0] + this.#activePanContext.domainWidth;
  //     this.#velocity[1] = this.#velocity[0];
  //   } else {
  //     // Zoom physics - independent springs
  //     for (let i = 0; i < 2; i++) {
  //       const distance = this.#target[i] - this.#physicsCurrent[i];
  //       const springForce = distance * this.#currentSpringConfig.stiffness;
  //       const dampingForce = -this.#velocity[i] * this.#currentSpringConfig.damping;
  //       const acceleration = springForce + dampingForce;
        
  //       this.#velocity[i] += acceleration * dt;
  //       this.#physicsCurrent[i] += this.#velocity[i] * dt;
  //     }
  //   }
    
  //   // Check if at target (same as before)
  //   if (this.#isAtTarget()) {
  //     this.#isAnimating = false;
  //     this.#gpuCoordinator.removeAnimatingScale(this);
  //   }
  // }


  _capturePhysicsStateForInterpolation() {
    this.#physicsPrevious[0] = this.#physicsCurrent[0];
    this.#physicsPrevious[1] = this.#physicsCurrent[1];
  }

  // _updatePhysics(deltaTime) {

  //   // Svelte's time clamping and normalization
  //   const elapsed = Math.min(deltaTime, 1000 / 30);
  //   const dt = (elapsed * 60) / 1000;
    
  //   // Smooth intermediate target
  //   // const smoothingFactor = 0.3; 
  //   // this.#smoothedTarget[0] += (this.#target[0] - this.#smoothedTarget[0]) * smoothingFactor;
  //   // this.#smoothedTarget[1] += (this.#target[1] - this.#smoothedTarget[1]) * smoothingFactor;
  //   // this.#smoothedTarget[0] += (this.#target[0] - this.#smoothedTarget[0]) * smoothingFactor * dt;
  //   // this.#smoothedTarget[1] += (this.#target[1] - this.#smoothedTarget[1]) * smoothingFactor * dt;

  //   const retainFactor = 0.5; // Adjust this for more/less rubber band
  //   const smoothingFactor = 1 - Math.pow(retainFactor, dt);
    
  //   this.#smoothedTarget[0] += (this.#target[0] - this.#smoothedTarget[0]) * smoothingFactor;
  //   this.#smoothedTarget[1] += (this.#target[1] - this.#smoothedTarget[1]) * smoothingFactor;

  //   // Svelte's inv_mass recovery (for momentum/soft animations)
  //   this.#inverseMass = Math.min(this.#inverseMass + (1000 / (60 * 60)), 1);
    
  //   const ctx = {
  //     inv_mass: this.#inverseMass,
  //     opts: this.#currentSpringConfig,
  //     settled: true,
  //     dt: dt
  //   };
    
  //   if (this.#activePanContext) {
  //     // Pan physics - single value with rigid body
  //     const last_value = this.#physicsPrevious[0];
  //     const current_value = this.#physicsCurrent[0];
  //     // const target_value = this.#target[0];
  //     const target_value = this.#smoothedTarget[0]; // Chase smoothed target
  //     const next_value = this.#tickSpring(ctx, last_value, current_value, target_value);
      
  //     // Update positions
  //     // this.#physicsPrevious[0] = this.#physicsCurrent[0];
  //     // this.#physicsPrevious[1] = this.#physicsCurrent[1];
  //     this.#physicsCurrent[0] = next_value;
  //     this.#physicsCurrent[1] = next_value + this.#activePanContext.domainWidth;
      
  //   } else {
  //     // Zoom physics - independent springs
  //     for (let i = 0; i < 2; i++) {
  //       const last_value = this.#physicsPrevious[i];
  //       const current_value = this.#physicsCurrent[i];
  //       // const target_value = this.#target[i];
  //       const target_value = this.#smoothedTarget[i];
        
  //       const next_value = this.#tickSpring(ctx, last_value, current_value, target_value);
        
  //       // this.#physicsPrevious[i] = this.#physicsCurrent[i];
  //       this.#physicsCurrent[i] = next_value;
  //     }
  //   }

  //   const targetDelta = Math.abs(this.#smoothedTarget[0] - this.#target[0]);
  //   const targetSettled = targetDelta < ctx.opts.precision;
    
  //   // Stop animation if settled
  //   if (ctx.settled && targetSettled) {
  //     this.#isAnimating = false;
  //     this.#gpuCoordinator.removeAnimatingScale(this);
  //   }

  //   // if (this.#activePanContext && Math.random() < 0.05) { // Log 5% of frames
  //   //   console.log('Smoothing debug:', {
  //   //       target: this.#target[0].toFixed(2),
  //   //       smoothed: this.#smoothedTarget[0].toFixed(2),
  //   //       physics: this.#physicsCurrent[0].toFixed(2),
  //   //       delta: (this.#target[0] - this.#smoothedTarget[0]).toFixed(4),
  //   //       dt: dt.toFixed(3)
  //   //   });
  //   // }
  // }

  // _updatePhysics(deltaTime) {
  //   // Svelte's time clamping and normalization
  //   const elapsed = Math.min(deltaTime, 1000 / 30);
  //   const dt = (elapsed * 60) / 1000;
    
  //   // Svelte's inv_mass recovery (for momentum/soft animations)
  //   this.#inverseMass = Math.min(this.#inverseMass + (1000 / (60 * 60)), 1);
    
  //   const ctx = {
  //     inv_mass: this.#inverseMass,
  //     opts: this.#currentSpringConfig,
  //     settled: true,
  //     dt: dt
  //   };

  //   if (this.#activePanContext) {
  //     // === ACTIVE PANNING: Velocity drives target, spring chases ===
      
  //     // Drive target with clean, resampled velocity (no decay here)
  //     const dtSeconds = deltaTime / 1000.0;
  //     const displacement = this.#inputVelocity * dtSeconds;
  //     this.#target[0] += displacement;
  //     this.#target[1] += displacement;
      
  //     // Apply domain constraints with rubber band resistance
  //     this.#applyBoundaryResistance(dt);
      
  //     // Smooth intermediate target for even better feel
  //     const retainFactor = 0.5;
  //     const smoothingFactor = 1 - Math.pow(retainFactor, dt);
  //     this.#smoothedTarget[0] += (this.#target[0] - this.#smoothedTarget[0]) * smoothingFactor;
  //     this.#smoothedTarget[1] += (this.#target[1] - this.#smoothedTarget[1]) * smoothingFactor;

  //     // Single spring for min value (rigid body)
  //     const last_value = this.#physicsPrevious[0];
  //     const current_value = this.#physicsCurrent[0];
  //     const target_value = this.#smoothedTarget[0];
  //     const next_value = this.#tickSpring(ctx, last_value, current_value, target_value);
      
  //     this.#physicsCurrent[0] = next_value;
  //     this.#physicsCurrent[1] = next_value + this.#activePanContext.domainWidth;
      
  //   } else if (Math.abs(this.#velocity[0]) > 0.0001) {
  //     // === MOMENTUM PHASE: Direct velocity integration ===
      
  //     const dtSeconds = deltaTime / 1000.0;
      
  //     // Project next position
  //     let nextMin = this.#physicsCurrent[0] + this.#velocity[0] * dtSeconds * 60; // Scale for smooth momentum
  //     let nextMax = this.#physicsCurrent[1] + this.#velocity[1] * dtSeconds * 60;
  //     const currentWidth = nextMax - nextMin;
      
  //     // Check for boundary collision and apply damped bounce
  //     const { min: minLimit, max: maxLimit } = this.domainLimits;
  //     if ((nextMin < minLimit && this.#velocity[0] < 0) || (nextMax > maxLimit && this.#velocity[0] > 0)) {
  //       // Snap to boundary
  //       if (nextMin < minLimit) {
  //         this.#physicsCurrent[0] = minLimit;
  //         this.#physicsCurrent[1] = minLimit + currentWidth;
  //       } else {
  //         this.#physicsCurrent[1] = maxLimit;
  //         this.#physicsCurrent[0] = maxLimit - currentWidth;
  //       }
  //       // Damped bounce
  //       this.#velocity[0] *= -this.#momentumBoundaryDamping || -0.3;
  //       this.#velocity[1] *= -this.#momentumBoundaryDamping || -0.3;
  //     } else {
  //       // Normal momentum decay
  //       this.#physicsCurrent[0] = nextMin;
  //       this.#physicsCurrent[1] = nextMax;
  //       this.#velocity[0] *= this.#panMomentumFactor || 0.95;
  //       this.#velocity[1] *= this.#panMomentumFactor || 0.95;
  //     }
      
  //     // Keep target aligned with physics during momentum
  //     this.#target[0] = this.#physicsCurrent[0];
  //     this.#target[1] = this.#physicsCurrent[1];
  //     this.#smoothedTarget[0] = this.#physicsCurrent[0];
  //     this.#smoothedTarget[1] = this.#physicsCurrent[1];
      
  //   } else {
  //     // === ZOOM/SETTLING: Normal spring behavior ===
      
  //     // Smooth intermediate target
  //     const retainFactor = 0.5;
  //     const smoothingFactor = 1 - Math.pow(retainFactor, dt);
  //     this.#smoothedTarget[0] += (this.#target[0] - this.#smoothedTarget[0]) * smoothingFactor;
  //     this.#smoothedTarget[1] += (this.#target[1] - this.#smoothedTarget[1]) * smoothingFactor;

  //     // Independent springs for both min and max (needed for zoom)
  //     for (let i = 0; i < 2; i++) {
  //       const last_value = this.#physicsPrevious[i];
  //       const current_value = this.#physicsCurrent[i];
  //       const target_value = this.#smoothedTarget[i];
  //       const next_value = this.#tickSpring(ctx, last_value, current_value, target_value);
  //       this.#physicsCurrent[i] = next_value;
  //     }
  //   }

  //   // Final hard clamp (safety net)
  //   this.#applyHardClamp();

  //   // Check if animation should stop
  //   const targetDelta = Math.abs(this.#smoothedTarget[0] - this.#target[0]);
  //   const targetSettled = targetDelta < ctx.opts.precision;
    
  //   if (ctx.settled && targetSettled && !this.#activePanContext && Math.abs(this.#velocity[0]) < 0.001) {
  //     this.#isAnimating = false;
  //     this.#gpuCoordinator.removeAnimatingScale(this);
  //   }
  // }

  _updatePhysics(deltaTime) {
    const dt = deltaTime / 1000.0;
    const { min: minLimit, max: maxLimit } = this.domainLimits;

    // --- 1. UPDATE TARGET (if panning) ---
    if (this.#activePanContext) {
      // The target is driven by our smoothed, resampled velocity.
      const panDelta = this.#panVelocity * dt;
      this.#target[0] += panDelta;
      this.#target[1] += panDelta;
    }
    
    // --- 2. CALCULATE FORCES (for the spring) ---
    this.#physicsPrevious[0] = this.#physicsCurrent[0];
    this.#physicsPrevious[1] = this.#physicsCurrent[1];
    
    // Calculate distance for the main spring force
    let distance = this.#target[0] - this.#physicsCurrent[0];
    
    // Calculate overpan for the boundary resistance force
    const domainWidth = this.#physicsCurrent[1] - this.#physicsCurrent[0];
    let overpan = 0;
    if (this.#physicsCurrent[0] < minLimit) {
      overpan = minLimit - this.#physicsCurrent[0];
    } else if (this.#physicsCurrent[0] + domainWidth > maxLimit) {
      overpan = maxLimit - (this.#physicsCurrent[0] + domainWidth);
    }
    
    // --- 3. APPLY FORCES & INTEGRATE (the core physics step) ---
    
    // Main spring force (always active, pulls towards target)
    const springForce = distance * this.#currentSpringConfig.stiffness;
    
    // Boundary resistance force (only active when overpanning)
    const resistanceForce = overpan * this.#currentSpringConfig.stiffness * this.#boundaryResistanceFactor;
    
    // Damping force (always active, opposes motion)
    const dampingForce = -this.#velocity[0] * this.#currentSpringConfig.damping;
    
    // Sum forces to get acceleration
    const acceleration = springForce + dampingForce + resistanceForce;
    
    // Integrate acceleration to get new velocity
    this.#velocity[0] += acceleration * dt;
    
    // Integrate velocity to get new position
    this.#physicsCurrent[0] += this.#velocity[0] * dt;
    
    // The other side of the domain follows rigidly
    this.#physicsCurrent[1] = this.#physicsCurrent[0] + domainWidth;
    this.#velocity[1] = this.#velocity[0];

    // --- 4. HANDLE MOMENTUM (after user releases) ---
    if (!this.#activePanContext) {
      // If coasting, apply momentum decay directly to the velocity
      this.#velocity[0] *= this.#panMomentumFactor;
      this.#velocity[1] *= this.#panMomentumFactor;

      // Boundary collision check for momentum
      if ((this.#physicsCurrent[0] < minLimit && this.#velocity[0] < 0) || (this.#physicsCurrent[1] > maxLimit && this.#velocity[0] > 0)) {
          this.#velocity[0] *= -this.#momentumBoundaryDamping; // Damp and reverse
          this.#velocity[1] *= -this.#momentumBoundaryDamping;
      }
    }

    // --- 5. CHECK SETTLING CONDITION ---
    const isSettled = Math.abs(this.#velocity[0]) < 0.001 && Math.abs(this.#target[0] - this.#physicsCurrent[0]) < 0.001;

    if (isSettled && !this.#activePanContext) {
      this.#velocity = [0, 0];
      this.#isAnimating = false;
      this.#gpuCoordinator.removeAnimatingScale(this);
    }
  }

  // Helper method for boundary resistance during active panning
  #applyBoundaryResistance(dt) {
    if (!this.#activePanContext) return;
    
    const { min: minLimit, max: maxLimit } = this.domainLimits;
    const domainWidth = this.#target[1] - this.#target[0];
    let overpan = 0;

    if (this.#target[0] < minLimit) {
      overpan = minLimit - this.#target[0];
    } else if (this.#target[0] + domainWidth > maxLimit) {
      overpan = maxLimit - (this.#target[0] + domainWidth);
    }

    if (Math.abs(overpan) > 0.001) {
      // Apply resistance force scaled to spring stiffness
      // const boundaryResistanceFactor = 3.0;
      // const resistanceForce = overpan * this.#currentSpringConfig.stiffness * this.#boundaryResistanceFactor;
      
      // Apply resistance by adjusting target velocity
      const velocityAdjustment = resistanceForce * dt;
      this.#inputVelocity += velocityAdjustment * 0.1; // Small factor to prevent oscillation
    }
  }

  // Helper method for final hard clamp
  #applyHardClamp() {
    const { min: minLimit, max: maxLimit } = this.domainLimits;
    const currentWidth = this.#physicsCurrent[1] - this.#physicsCurrent[0];

    if (this.#physicsCurrent[0] < minLimit) {
      this.#physicsCurrent[0] = minLimit;
      this.#physicsCurrent[1] = minLimit + currentWidth;
    } else if (this.#physicsCurrent[1] > maxLimit) {
      this.#physicsCurrent[1] = maxLimit;
      this.#physicsCurrent[0] = maxLimit - currentWidth;
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

  _setRenderState(alpha) {
    this.#renderCurrent[0] = this.#physicsPrevious[0] * (1.0 - alpha) + this.#physicsCurrent[0] * alpha;
    // this.#renderCurrent[1] = this.#physicsPrevious[1] * (1.0 - alpha) + this.#physicsCurrent[1] * alpha;
  
    if (this.#activePanContext) {
      // Maintain rigid body constraint during interpolation
      this.#renderCurrent[1] = this.#renderCurrent[0] + this.#activePanContext.domainWidth;
    } else {
      this.#renderCurrent[1] = this.#physicsPrevious[1] * (1.0 - alpha) + this.#physicsCurrent[1] * alpha;
    }
    // this.#renderCurrent = [
      // this.#physicsPrevious[0] * (1.0 - alpha) + this.#physicsCurrent[0] * alpha,
      // this.#physicsPrevious[1] * (1.0 - alpha) + this.#physicsCurrent[1] * alpha
    // ];

    // console.log(`Alpha: ${alpha.toFixed(3)}, Prev: ${this.#physicsPrevious[0].toFixed(3)}, Curr: ${this.#physicsCurrent[0].toFixed(3)}, Render: ${this.#renderCurrent[0].toFixed(3)}`);

    // console.log(`Render state: current=${this.#renderCurrent[0].toFixed(6)}, ${this.#renderCurrent[1].toFixed(6)}`);
    // return this.#renderCurrent[0]
  }

  // _setRenderState() {
  //   // No interpolation - render state IS physics state
  //   this.#renderCurrent[0] = this.#physicsCurrent[0];
  //   this.#renderCurrent[1] = this.#physicsCurrent[1];
    
  //   return this.#renderCurrent[0];
  // }

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