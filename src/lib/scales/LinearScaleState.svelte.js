import { Tween } from 'svelte/motion';
import { cubicOut, cubicInOut } from 'svelte/easing';
import { scaleLinear } from 'd3-scale';
import { extent as d3Extent } from 'd3-array';

// current zoom tweens, extents, and filtering?
const tweenOptions = {
  duration: 300,
  easing: cubicOut,
};

export class LinearScaleState {
  // Basic scale properties
  name = $state('');  // e.g., 'x', 'y', 'color'

  #initExtent = [];
  #extent = [];
  #extents = new Map(); // Stores all extents in map by mark identifier
  // domain = new Tween([0, 100], tweenOptions);
  domainLimits = {
    min: 0,
    max: 100,
    minWidth: 1
  };
  zoomLimits = {
    max: 10,
    min: 100
  }

  // Syncing crosshair and labels for mouse position
  currentDataPoint = $state();

  // Freeze/debounce functionality
  #enableUpdates = $state(true);
  #frozenExtent = null; // Stores the frozen extent when updates are disabled

  constructor(name, extent = [0, 100], type = 'linear', zoomLimits = [10, 100], options = {}) {
    this.name = name;
    this.#initExtent = extent;
    this.#extent = extent;
    this.type = type;
    this.zoomLimits.max = zoomLimits[0]
    this.zoomLimits.min = zoomLimits[1]
    this.ready = $state(false);
    this.domain = new Tween(extent, tweenOptions);

    this.zoomInEffect = {
      enabled: options.zoomInEffect ?? true,
      factor: options.zoomInFactor ?? 5,
      duration: options.zoomInDuration ?? 600, //need to match regular
      easing: options.zoomInEasing ?? cubicOut
    };
  }

  setReady() {
    this.ready = true;
  }

  /**
   * Enable or disable scale updates (freeze scale when disabled)
   * @param {boolean} enabled - Whether to enable scale updates
   */
  setUpdatesEnabled(enabled) {
    const wasEnabled = this.#enableUpdates;
    this.#enableUpdates = enabled;
    
    if (wasEnabled && !enabled) {
      // Just disabled - freeze current extent
      this.#frozenExtent = [...this.#extent];
    } else if (!wasEnabled && enabled) {
      // Just enabled - unfreeze and recalculate if needed
      this.#frozenExtent = null;
      this.updateExtentFromExtents();
    }
  }

  /**
   * Get current updates state
   * @returns {boolean} Whether updates are enabled
   */
  get updatesEnabled() {
    return this.#enableUpdates;
  }

  /**
   * Get the effective extent (frozen or current)
   * @returns {Array} The extent being used
   */
  get effectiveExtent() {
    return this.#enableUpdates ? this.#extent : this.#frozenExtent || this.#extent;
  }

  addMark(range, identifier) {
    let processedRange;
    
    // Process based on array length
    if (range.length === 2) {
      // For length 2, ensure first value is smaller than second
      processedRange = [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
    } else if (range.length > 2) {
      // For larger arrays, run d3.extent
      processedRange = d3Extent(range);
    } else if (range.length === 1) {
      // Handle single value case - create a range with the same value
      processedRange = [range[0], range[0]];
    } else {
      // Empty array case - fail silently or with minimal logging
      return this;
    }
    
    // Store the processed range with its identifier
    this.#extents.set(identifier, processedRange);

    if (this.#enableUpdates) {
      this.updateExtentFromExtents();
    }

    console.log(`📊 Scale ${this.name}: addMark from ${identifier}`, {
      range,
      oldExtent: [...this.#extent],
      newExtent: [...this.#extent],  // After update
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

  // Update the extent based on all ranges in the map
  updateExtentFromExtents(nice=true) {
    // Don't update if frozen
    if (!this.#enableUpdates) {
      return;
    }

    if (this.#extents.size === 0) {
      // Default value when no ranges are present
      this.#extent = [0, 0];
      return;
    }
    
    const extents = Array.from(this.#extents.values());
    
    // Find the min and max value
    const minStart = Math.min(...extents.map(range => range[0]));
    const maxEnd = Math.max(...extents.map(range => range[1]));
    
    // console.log(`Computing extent from extents: min=${minStart}, max=${maxEnd}`);
    if (nice) {
      // TODO include min ticks per chart instance here? Slight mis-match otherwise.
      // Want the same domain across instances so makes sense to keep calculation here
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

  applyZoomDomain(innerPoint, scaleFactor) {

    const [min, max] = this.domain.target;
    const minLimit = this.domainLimits.min;
    const maxLimit = this.domainLimits.max;
    const limitWidth = maxLimit - minLimit;
    const minDomainWidth = this.domainLimits.minWidth;

    // Calculate how far the mouse is along the scale (0 to 1)
    const mouseRatio = (innerPoint - min) / (max - min);

    // Calculate the new domain range (current range divided by zoom factor)
    const newDomainWidth = (max - min) / scaleFactor;
    const effectiveDomainWidth = Math.max(newDomainWidth, minDomainWidth);

    let newMin = innerPoint - (mouseRatio * effectiveDomainWidth);
    let newMax = newMin + effectiveDomainWidth;

    // Check if new domain width exceeds limit width
    if (effectiveDomainWidth > limitWidth) {
      // Set to full available range if zoom out is too extreme
      newMin = minLimit;
      newMax = maxLimit;
      this.currentDataPoint = null; // crosshair gets offset until new mouse move

    } else {
      // Ensure the domain stays within the limits while preserving width
      if (newMin < minLimit) {
        newMin = minLimit;
        newMax = newMin + effectiveDomainWidth; // Preserve width
        this.currentDataPoint = null; // crosshair gets offset until new mouse move
      }
      
      if (newMax > maxLimit) {
        newMax = maxLimit;
        newMin = newMax - effectiveDomainWidth; // Preserve width
        this.currentDataPoint = null; // crosshair gets offset until new mouse move
        
        // Double-check if this pushed us below minLimit
        if (newMin < minLimit) {
          newMin = minLimit;
          // We can't preserve the width in this case
        }
      }
    }

    this.domain.target = [newMin, newMax];
  }

  applyPanDomain(dx) {
    const [min, max] = this.domain.current;
    const range = max - min;
    
    // First check if we'd exceed either limit
    if (min + dx < this.domainLimits.min) {
        // Would exceed minimum limit, snap to minimum
        this.domain.target = [this.domainLimits.min, this.domainLimits.min + range];
    } else if (max + dx > this.domainLimits.max) {
        // Would exceed maximum limit, snap to maximum
        this.domain.target = [this.domainLimits.max - range, this.domainLimits.max];
    } else {
        // Within bounds, apply the pan normally
        this.domain.target = [min + dx, max + dx];
    }
  }

  updateScaleDomain(scale, current = true) {
    // Use effective extent for scale domain calculation
    const targetDomain = current ? this.domain.current : this.domain.target;
    return { scale: scale.domain(targetDomain) }
  }

  resetZoom() {
    const [currentMin, currentMax] = this.domain.target;
    const [targetMin, targetMax] = this.effectiveExtent;
    
    // Use the magnitude of the data to determine tolerance
    const dataScale = Math.max(
      Math.abs(targetMin), 
      Math.abs(targetMax), 
      Math.abs(targetMax - targetMin)
    );
    
    // Tolerance is 0.01% of the data scale (or minimum epsilon for very small numbers)
    const tolerance = Math.max(dataScale * 0.0001, Number.EPSILON * 1000);
    
    const alreadyTargetingCorrectExtent = 
      Math.abs(currentMin - targetMin) < tolerance && 
      Math.abs(currentMax - targetMax) < tolerance;
      
    if (alreadyTargetingCorrectExtent) {
      return;
    }
  
    if (!this.ready && this.zoomInEffect.enabled) {
      const [min, max] = this.effectiveExtent;
      
      if (min === max || !isFinite(min) || !isFinite(max)) {
        console.warn(`⚠️ Scale ${this.name} skipping zoom effect - invalid extent:`, [min, max]);
        this.domain.set(this.effectiveExtent, { duration: 0 });
        return;
      }
      
      const center = (min + max) / 2;
      const range = max - min;
      const expandedRange = range * this.zoomInEffect.factor;
      const expandedExtent = [
        center - expandedRange / 2, 
        center + expandedRange / 2
      ];
  
  
      this.domain.set(expandedExtent, { duration: 0 });
      this.domain.set(this.effectiveExtent, { 
        duration: this.zoomInEffect.duration,
        easing: this.zoomInEffect.easing
      });
      
    } else if (!this.ready) {
      this.domain.set(this.effectiveExtent, { duration: 0 });
      
    } else {
      this.domain.set(this.effectiveExtent, {duration: 600, easing: cubicInOut});
    }
  }

  resetDomainLimits() {
    // Use effective extent for domain limits
    const [min, max] = this.effectiveExtent;
    const width = max - min;

    this.domainLimits.min = min - this.zoomLimits.max * width
    this.domainLimits.max = max + this.zoomLimits.max * width
    this.domainLimits.minWidth = width / this.zoomLimits.min;
  }
    
  zoomToRange([min, max]) {
    this.domain.target = [min, max];
  }

  /**
   * Get debug information about current state
   * @returns {Object} Debug information
   */
  getDebugInfo() {
    return {
      updatesEnabled: this.#enableUpdates,
      currentExtent: [...this.#extent],
      frozenExtent: this.#frozenExtent ? [...this.#frozenExtent] : null,
      effectiveExtent: [...this.effectiveExtent],
      extentsCount: this.#extents.size,
      extents: Object.fromEntries(this.#extents)
    };
  }

  destroy() {
    this.#frozenExtent = null;
  }
}