import { Spring } from 'svelte/motion';
import { cubicOut, cubicInOut } from 'svelte/easing';
import { scaleLinear } from 'd3-scale';
import { extent as d3Extent } from 'd3-array';

// Spring options for smooth domain transitions
const springOptions = {
  stiffness: 0.15,
  damping: 0.8,
  precision: 0.01
};

// Different spring settings for different interaction types
const springConfigs = { 
  default: { stiffness: 0.15, damping: 0.8, precision: 0.001 },
  zoom: { stiffness: 0.2, damping: 0.85, precision: 0.001 },
  pan: { stiffness: 0.2, damping: 0.7, precision: 0.001 },
  reset: { stiffness: 0.075, damping: 0.7, precision: 0.001 },
  zoomIn: { stiffness: 0.08, damping: 0.7, precision:  0.001 }
  // default: { stiffness: 0.15, damping: 0.8, precision: Number.EPSILON * 1 },
  // zoom: { stiffness: 0.2, damping: 0.85, precision: Number.EPSILON * 1 },
  // pan: { stiffness: 0.2, damping: 0.7, precision: Number.EPSILON * 1 },
  // reset: { stiffness: 0.075, damping: 0.7, precision: Number.EPSILON * 1 },
  // zoomIn: { stiffness: 0.08, damping: 0.7, precision:  Number.EPSILON * 1 }
};

export class LinearScaleState {
  id = crypto.randomUUID();
  name = $state('');

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
  }

  // Syncing crosshair and labels for mouse position
  currentDataPoint = $state();

  // Freeze/debounce functionality
  #enableUpdates = $state(true);
  #frozenExtent = null;

  constructor(name, extent = [0, 100], type = 'linear', zoomLimits = [10, 100], options = {}) {
    this.name = name;
    this.#initExtent = extent;
    this.#extent = extent;
    this.type = type;
    this.zoomLimits.max = zoomLimits[0]
    this.zoomLimits.min = zoomLimits[1]
    this.ready = $state(false);    
    this.domain = new Spring(extent, springOptions);

    this.zoomInEffect = {
      enabled: options.zoomInEffect ?? true,
      factor: options.zoomInFactor ?? 5,
      // duration: options.zoomInDuration ?? 600, // Still used for timing reference
      springConfig: options.zoomInSpringConfig ?? springConfigs.zoomIn
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

  // Update spring physics parameters for different interaction types
  #updateSpringConfig(config) {
    this.domain.stiffness = config.stiffness;
    this.domain.damping = config.damping;
    this.domain.precision = config.precision;
  }

  applyZoomDomain(innerPoint, scaleFactor) {
    // Use snappier spring for zoom interactions
    this.#updateSpringConfig(springConfigs.zoom);

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

    // Spring: just set target directly
    this.domain.target = [newMin, newMax];
  }

  applyPanDomain(dx) {
    // Use even snappier spring for pan interactions
    this.#updateSpringConfig(springConfigs.pan);

    const [min, max] = this.domain.current;
    let newMin = min + dx;
    let newMax = max + dx;
    
    const range = max - min;
    if (newMin < this.domainLimits.min) {
        newMin = this.domainLimits.min;
        newMax = newMin + range;
    } else if (newMax > this.domainLimits.max) {
        newMax = this.domainLimits.max;
        newMin = newMax - range;
    }

    // Spring: just set target directly
    this.domain.target = [newMin, newMax];
    console.log(this.domain)
  }

  setConstrainedDomain(newDomain) {
    // Use default spring config
    // this.#updateSpringConfig(springConfigs.default);
    this.#updateSpringConfig(springConfigs.pan);

    let [newMin, newMax] = newDomain;
    
    // Reuse existing constraint logic from applyPanDomain
    const range = newMax - newMin;
    if (newMin < this.domainLimits.min) {
      newMin = this.domainLimits.min;
      newMax = newMin + range;
    } else if (newMax > this.domainLimits.max) {
      newMax = this.domainLimits.max;
      newMin = newMax - range;
      
      // Double-check if this pushed us below minLimit
      if (newMin < this.domainLimits.min) {
        newMin = this.domainLimits.min;
        // We can't preserve the width in this case
      }
    }
    
    this.domain.target = [newMin, newMax];
  }

  updateScaleDomain(scale, current = true) {
    // Use effective extent for scale domain calculation
    const targetDomain = current ? this.domain.current : this.domain.target;
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
      
      this.domain.set(expandedExtent, { instant: true });
      this.domain.target = targetExtent;
    } else if (!this.ready) {
      // Not ready, no animation
      this.domain.set(targetExtent, { instant: true });
    } else {
      // Normal reset with animation
      this.#updateSpringConfig(springConfigs.reset);
      this.domain.target = targetExtent;
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
    this.#updateSpringConfig(springConfigs.default);
    this.domain.target = [min, max];
  }

  #domainScaleFactor = $derived.by(() => {
    const [min, max] = this.domain.current;
    const range = max - min;
    
    // Handle the division-by-zero edge case.
    return range === 0 ? 0 : 1 / range;
  });

  get gpuState() {
      const [min, max] = this.domain.current;

      return {
          domainMin: min,
          domainMax: max,
          categoryCount: 0,
          domainScale: this.#domainScaleFactor
      };
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
      extents: Object.fromEntries(this.#extents),
      springConfig: {
        stiffness: this.domain.stiffness,
        damping: this.domain.damping,
        precision: this.domain.precision
      }
    };
  }

  destroy() {
    this.#frozenExtent = null;
  }
}