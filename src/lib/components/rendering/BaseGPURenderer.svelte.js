/**
 * Base class for GPU-based renderers that handles common patterns:
 * - Resource lifecycle management
 * - Buffer creation and updates
 * - Scale parameter management with universal scale support
 * - GPU coordinator integration
 * - Error handling and cleanup
 */
export class BaseGPURenderer {
  // Core properties
  #markType;
  #webGPUContext;
  #gpuCoordinator;
  #chartContext;

  // Resource tracking
  #ownedResources = {
    pipeline: false,
    shader: false,
    buffers: [],
    layerControl: null
  };

  // State management
  #resourcesCreated = $state(false);
  #initializationError = $state(null);
  #instanceCount = $state(0);

  // GPU resources
  #device = null;
  #pipeline = $state(null);
  #bindGroup = $state(null);
  #scaleParamsArray = new Float32Array(32);
  #scaleParamsBuffer = $state(null);
  #resolutionBuffer = $state(null);
  #dprBuffer = $state(null);

  // Resource tracking
  #ownedBuffers = []; 
  #layerControl = null;

  // Configuration
  #zIndex;
  #devicePixelRatio;
  #xScaleType;
  #yScaleType;

  constructor(markType, webGPUContext, gpuCoordinator, chartContext, options = {}) {
    this.#markType = markType;
    this.#webGPUContext = webGPUContext;
    this.#gpuCoordinator = gpuCoordinator;
    this.#chartContext = chartContext;
    this.#zIndex = options.zIndex || 0;
    this.#devicePixelRatio = window.devicePixelRatio || 1;
    
    // Store explicit scale types passed from mark components
    this.#xScaleType = options.xScaleType || 'linear';
    this.#yScaleType = options.yScaleType || 'linear';
  }

  // ===== STATIC METHODS FOR CENTRALIZED SCALE SUPPORT =====

  /**
   * Get standardized scale shader fragment that all components can use
   * This contains the struct definition and universal scale functions
   */
  static getScaleShaderFragment() {
    return `
      struct ScaleParams {
        domainMin: vec2<f32>,       // [0-1] Domain minimums
        domainMax: vec2<f32>,       // [2-3] Domain maximums
        rangeMin: vec2<f32>,        // [4-5] Range minimums
        rangeMax: vec2<f32>,        // [6-7] Range maximums
        scaleTypes: vec2<f32>,      // [8-9] Scale type constants (0=linear, 1=band, 3=identity)
        bandwidth: vec2<f32>,       // [10-11] Band scale bandwidths
        padding: vec2<f32>,         // [12-13] Band scale padding
        categoryCount: vec2<f32>,   // [14-15] Number of categories for band scales

        // Pre-computed optimization values
        domainScale: vec2<f32>,     // 1.0 / (domainMax - domainMin)
        rangeSize: vec2<f32>,       // rangeMax - rangeMin
        
        // Padding to ensure 128-byte alignment, ready for future use
        padding_0: vec2<f32>,
        padding_1: vec2<f32>,
        padding_2: vec2<f32>,
        padding_3: vec2<f32>,
        padding_4: vec2<f32>,
        padding_5: vec2<f32>,
      };

      // Universal scaling function that handles all scale types
      fn scaleValue(
        value: f32, 
        scaleType: f32,
        domainMin: f32, 
        domainScale: f32,
        rangeMin: f32, 
        rangeSize: f32,
        bandwidth: f32,
        categoryCount: f32
      ) -> f32 {
        if (scaleType == 0.0) {
          // Linear scale
          let normalized = (value - domainMin) * domainScale;
          return rangeMin + normalized * rangeSize;
          
        } else if (scaleType == 1.0) {
          // Band scale: value is category index, position at center of band
          let categoryIndex = floor(value);
          let step = rangeSize / categoryCount;
          
          // Position at center of the band
          return rangeMin + categoryIndex * step + bandwidth * 0.5;
          
        } else if (scaleType == 2.0) {
          // Point scale: evenly distributed points
          let categoryIndex = floor(value);
          let step = rangeSize / max(1.0, categoryCount - 1.0);
          
          return rangeMin + categoryIndex * step;
          
        } else if (scaleType == 3.0) {
          // Identity scale: pass through (for pixel coordinates)
          return value;
          
        }
        
        // Fallback to linear for unknown scale types
        let normalized = (value - domainMin) * domainScale;
        return rangeMin + normalized * rangeSize;
      }

      // Convenience functions for X and Y axes - components call these
      fn scaleX(value: f32, scaleParams: ScaleParams) -> f32 {
        return scaleValue(
          value,
          scaleParams.scaleTypes.x,
          scaleParams.domainMin.x,
          scaleParams.domainScale.x,
          scaleParams.rangeMin.x,
          scaleParams.rangeSize.x,
          scaleParams.bandwidth.x,
          scaleParams.categoryCount.x
        );
      }

      fn scaleY(value: f32, scaleParams: ScaleParams) -> f32 {
        return scaleValue(
          value,
          scaleParams.scaleTypes.y,
          scaleParams.domainMin.y,
          scaleParams.domainScale.y,
          scaleParams.rangeMin.y,
          scaleParams.rangeSize.y,
          scaleParams.bandwidth.y,
          scaleParams.categoryCount.y
        );
      }
    `;
  }

  /**
   * Get standard binding constants that all components should use
   * This ensures consistent binding layout across all shaders
   */
  static getStandardBindings() {
    return {
      RESOLUTION: 0,
      // Data bindings 1-5 are component-specific
      SCALE_PARAMS: 6,
      DEVICE_PIXEL_RATIO: 7
    };
  }

  /**
   * Generate complete shader code by combining scale fragment with component code
   * This is the main function components use to get their complete shader
   */
  static generateShader(componentSpecificCode) {
    const scaleFragment = BaseGPURenderer.getScaleShaderFragment();
    
    return `
      ${scaleFragment}
      
      ${componentSpecificCode}
    `;
  }

  // ===== DATA PROCESSING HELPERS =====

  /**
   * Process data for GPU consumption based on scale types
   * @param {Array} data - Raw data array
   * @param {string} axis - 'x' or 'y'
   * @returns {Float32Array} Processed data ready for GPU
   */
  processDataForAxis(data, axis) {
    const scaleType = axis === 'x' ? this.#xScaleType : this.#yScaleType;
    const scaleState = axis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;

    switch (scaleType) {
      case 'linear':
        case 'identity':
          // Pass through numeric values - GPU will handle scaling
        return new Float32Array(data.map(d => d ?? 0));
        
      case 'band':
      case 'point':
        // CPU: Convert strings to indices, GPU: Convert indices to positions
        return scaleState.processDataForGPU(data, this.#markType);
        // return this.#convertCategoriesToIndices(data, scale, axis);  TODO: remove old method, logic moved to scaleState where it belongs!
        
      case 'log':
        // Future: logarithmic scale support
        return new Float32Array(data.map(d => Math.log(Math.max(d || 1, 1))));
        
      case 'time':
        // Future: temporal scale support  
        return new Float32Array(data.map(d => d instanceof Date ? d.getTime() : d || 0));
        
      default:
        console.warn(`Unknown scale type: ${scaleType}, treating as linear`);
        return new Float32Array(data.map(d => d ?? 0));
    }
  }

  // ===== PUBLIC GETTERS =====

  get resourcesCreated() { return this.#resourcesCreated; }
  get initializationError() { return this.#initializationError; }
  get instanceCount() { return this.#instanceCount; }
  get pipeline() { return this.#pipeline; }
  get bindGroup() { return this.#bindGroup; }
  get markType() { return this.#markType; }

  // ===== INITIALIZATION =====

  /**
   * Initialize the renderer with shape-specific configuration
   * @param {Object} config - Shape-specific configuration
   * @param {string} config.shaderCode - WGSL shader code (should be generated with generateShader)
   * @param {Array} config.vertexBufferLayout - Bind group layout configuration
   */
  async initialize(config) {
    try {
      // console.log(`🔧 Initializing ${this.#markType} renderer`);
      this.#device = this.#webGPUContext.getDevice();
      if (!this.#device) {
        throw new Error('No WebGPU device available from context');
      }

      await this.#createSharedResources(this.#device, config);
      await this.#createCommonBuffers(this.#device);
      
      this.#resourcesCreated = true;
      // console.log(`✅ ${this.#markType} renderer initialized successfully`);
      
    } catch (error) {
      console.error(`❌ ${this.#markType} renderer initialization failed:`, error);
      this.#initializationError = error.message;
      throw error;
    }
  }

  /**
   * Register this renderer as a layer with the GPU Coordinator.
   * @param {Function} drawFunction - Shape-specific draw function.
   */
  registerLayer(drawFunction) {
    try {
        // ✅ Get the chartId from the chartContext, which is stable.
        const chartId = this.#chartContext.chartId;

        // ✅ Create the configuration object for this specific layer.
        const layerConfig = {
            draw: drawFunction,
            markType: this.#markType,
            // Pass a reference to this renderer instance. The coordinator will
            // need this to access its state (pipeline, bindGroup) during the render loop.
            renderer: this, 
            componentId: `${this.#markType}-${crypto.randomUUID().slice(0, 6)}`
        };

        // ✅ Call the NEW registerLayer method on the COORDINATOR, not the webgpu-canvas context.
        this.#ownedResources.layerControl = this.#gpuCoordinator.registerLayer(chartId, layerConfig);

        // console.log(`📋 ${this.#markType} layer registered directly with coordinator for chart ${chartId}`);
        return this.#ownedResources.layerControl;

    } catch (error) {
        console.error(`❌ ${this.#markType} layer registration failed:`, error);
        this.#initializationError = error.message;
        throw error;
    }
  }

  // ===== SHARED RESOURCE MANAGEMENT =====

  async #createSharedResources(device, config) {
    if (!this.#gpuCoordinator) {
      throw new Error('GPU coordinator not available');
    }

    // Create or get shared shader
    const shaderModule = await this.#gpuCoordinator.getOrCreateSharedShader(
      this.#markType, 
      config.shaderCode
    );
    this.#ownedResources.shader = true;

    // Create or get shared pipeline
    this.#pipeline = await this.#gpuCoordinator.getOrCreateSharedPipeline(
      this.#markType, 
      async () => {
        const msaaSampleCount = this.#webGPUContext.getMsaaSampleCount();

        return device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: shaderModule,
            entryPoint: 'vertexMain',
            buffers: config.vertexBufferLayout || [],
          },
          fragment: {
            module: shaderModule,
            entryPoint: 'fragmentMain',
            targets: [{
              format: this.#webGPUContext.getPresentationFormat(),
              blend: {
                color: {
                  srcFactor: 'src-alpha',
                  dstFactor: 'one-minus-src-alpha',
                  operation: 'add',
                },
                alpha: {
                  srcFactor: 'one',
                  dstFactor: 'one-minus-src-alpha',
                  operation: 'add',
                },
              },
            }],
          },
          primitive: { topology: 'triangle-list' },
          multisample: { count: msaaSampleCount > 1 ? msaaSampleCount : 1 },
        });
      }
    );
    this.#ownedResources.pipeline = true;
  }

  async #createCommonBuffers(device) {
    // Create chart-specific uniform buffers
    this.#resolutionBuffer = device.createBuffer({
      size: 8, // vec2<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#ownedResources.buffers.push(this.#resolutionBuffer);

    this.#scaleParamsBuffer = device.createBuffer({
      size: 128, // 16 f32 values for enhanced scale parameters
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#ownedResources.buffers.push(this.#scaleParamsBuffer);

    // Use shared DPR buffer if available, create own if needed
    this.#dprBuffer = this.#gpuCoordinator?.getSharedUniformBuffer('devicePixelRatio');
    
    if (!this.#dprBuffer) {
      console.warn(`🔶 Creating own DPR buffer for ${this.#markType} - coordinator should provide this`);
      this.#dprBuffer = device.createBuffer({
        size: 4, // f32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.#dprBuffer, 0, new Float32Array([this.#devicePixelRatio]));
      this.#ownedResources.buffers.push(this.#dprBuffer);
    }

    // Update initial values
    this.updateResolution();
    this.updateScaleParameters();
  }

  // ===== BUFFER MANAGEMENT =====

  /**
   * Create or update a buffer with smart sizing to prevent thrashing
   * @param {GPUBuffer} existingBuffer - Existing buffer to potentially reuse
   * @param {TypedArray} data - Data to store in buffer
   * @param {number} usage - GPU buffer usage flags
   * @returns {GPUBuffer} New or existing buffer
   */
  createOrUpdateBuffer(existingBuffer, data, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) {
    // const device = this.#webGPUContext.getDevice();
    if (!this.#device) {
      throw new Error('No WebGPU device available');
    }
    
    const requiredSize = data.byteLength;
    
    // Only recreate if actually needed, with smart sizing strategy
    if (!existingBuffer || existingBuffer.size < requiredSize) {
      if (existingBuffer) {
        // Remove from tracking before destroying
        const index = this.#ownedResources.buffers.indexOf(existingBuffer);
        if (index !== -1) {
          this.#ownedResources.buffers.splice(index, 1);
        }
        existingBuffer.destroy();
      }

      // Smart sizing: grow in sensible chunks to prevent thrashing
      const MEMORY_BLOCK_SIZE = 256; // 256 bytes minimum block
      const desiredSize = Math.ceil(requiredSize * 1.5); // 50% headroom
      const roundedUpSize = Math.ceil(desiredSize / MEMORY_BLOCK_SIZE) * MEMORY_BLOCK_SIZE;
      let bufferSize = Math.max(requiredSize, roundedUpSize);
      bufferSize = (bufferSize + 3) & ~3; // Ensure 4-byte alignment

      const newBuffer = this.#device.createBuffer({
        size: bufferSize,
        usage,
      });
      
      this.#ownedResources.buffers.push(newBuffer);
      console.debug(`📊 Created ${this.#markType} buffer of size ${bufferSize} bytes (required: ${requiredSize})`);
      return newBuffer;
    }
    
    return existingBuffer;
  }

  /**
   * Update instance count and trigger layer invalidation
   * @param {number} count - New instance count
   */
  updateInstanceCount(count) {
    this.#instanceCount = count;
    this.invalidateLayer();
  }

  // ===== ENHANCED SCALE INTEGRATION =====

  /**
 * Updates the GPU's uniform buffer with all necessary scale parameters.
 * This function is on the "hot path" and is called on every frame during interactions.
 * It's optimized to be extremely fast by using a pre-allocated array and a
 * unified `gpuState` interface from the scale state objects.
 */
updateScaleParameters() {
    if (!this.#device || !this.#scaleParamsBuffer || !this.#chartContext) {
        return;
    }

    try {
      const c = this.#chartContext;
      const scaleParams = this.#scaleParamsArray;

      const xScaleState = c.xScaleState;
      const yScaleState = c.yScaleState;
      const scaleTypes = c.scaleTypes;

      if (!xScaleState || !yScaleState || !scaleTypes) return;

      const xGpuState = xScaleState.gpuState;
      const yGpuState = yScaleState.gpuState;

      // ---- Indices 0-7: Core Domain & Range ----
      scaleParams[0] = xGpuState.domainMin;
      scaleParams[1] = yGpuState.domainMin;
      scaleParams[2] = xGpuState.domainMax;
      scaleParams[3] = yGpuState.domainMax;
      scaleParams[4] = 0;
      scaleParams[5] = c.innerHeight;
      scaleParams[6] = c.innerWidth;
      scaleParams[7] = 0;

      // ---- Indices 8-15: Scale Type & Categorical Info ----
      scaleParams[8] = this.#getGPUScaleType(scaleTypes.x);
      scaleParams[9] = this.#getGPUScaleType(scaleTypes.y);
      scaleParams[10] = xScaleState.bandwidth ?? 0; // Get directly from state class
      scaleParams[11] = yScaleState.bandwidth ?? 0;
      scaleParams[12] = xScaleState.padding ?? 0;   // Assumes `padding` getter exists
      scaleParams[13] = yScaleState.padding ?? 0;
      scaleParams[14] = xGpuState.categoryCount;
      scaleParams[15] = yGpuState.categoryCount;

      // ---- Indices 16-23: Pre-computed Factors for Optimization ----
      // Get the pre-calculated domain scale factor (1 / (max - min))
      scaleParams[16] = xGpuState.domainScale ?? 0;
      scaleParams[17] = yGpuState.domainScale ?? 0;

      // Pre-calculate the range width/height
      scaleParams[18] = c.innerWidth;
      scaleParams[19] = -c.innerHeight;

      // The remaining slots (20-31) are reserved for future use (e.g., rangeScale factors)
      // It's good practice to zero them out.
      scaleParams.fill(0, 20);

      // Final, single write to the GPU command queue.
      this.#device.queue.writeBuffer(this.#scaleParamsBuffer, 0, scaleParams);
        
    } catch (error) {
      console.error(`❌ Failed to update scale parameters for ${this.#markType}:`, error);
    }
  }

  /**
   * Convert scale type string to GPU constant
   * @param {string} scaleType - Scale type ('linear', 'band', 'point', 'identity', 'log')
   * @returns {number} GPU scale type constant
   */
  #getGPUScaleType(scaleType) {
    switch (scaleType) {
      case 'linear': return 0;
      case 'band': return 1;
      case 'point': return 2;
      case 'identity': return 3;
      case 'log': return 4;
      case 'time': return 5;
      default:
        console.warn(`Unknown scale type: ${scaleType}, defaulting to linear`);
        return 0;
    }
  }

  /**
   * Update resolution buffer with current canvas dimensions
   */
  updateResolution() {
    if (!this.#resolutionBuffer) return;

    try {
      const device = this.#webGPUContext.getDevice();
      if (!device) return;

      const { width, height } = this.#webGPUContext.getCanvasDimensions();
      device.queue.writeBuffer(this.#resolutionBuffer, 0, new Float32Array([width, height]));
      
    } catch (error) {
      console.error(`❌ Failed to update resolution for ${this.#markType}:`, error);
    }
  }

  // ===== BIND GROUP MANAGEMENT =====

  /**
   * Create bind group with common bindings plus shape-specific ones
   * @param {Array} additionalBindings - Shape-specific bindings to add
   */
  createBindGroup(additionalBindings = []) {
    try {
      const device = this.#webGPUContext.getDevice();
      if (!device || !this.#pipeline) {
        console.warn(`⚠️ Cannot create bind group for ${this.#markType} - missing device or pipeline`);
        return;
      }

      // Common bindings that all shapes need (matches the binding constants)
      const commonBindings = [
        { binding: 0, resource: { buffer: this.#resolutionBuffer } },
        // Note: bindings 1-5 are typically reserved for shape-specific data buffers
        { binding: 6, resource: { buffer: this.#scaleParamsBuffer } },
        { binding: 7, resource: { buffer: this.#dprBuffer } },
      ];

      // Merge common and shape-specific bindings
      const allBindings = [...additionalBindings, ...commonBindings];

      this.#bindGroup = device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: allBindings,
      });

      console.debug(`✅ Bind group created for ${this.#markType}`);
      
    } catch (error) {
      console.error(`❌ Failed to create bind group for ${this.#markType}:`, error);
      this.#initializationError = error.message;
      throw error;
    }
  }

  // ===== REACTIVE EFFECTS HELPERS =====
    /**
   * Updates the GPU buffer that contains scale parameters (domain, range, etc.).
   * This should be called whenever the scale's domain or range changes.
   * @param {Function} callback - Optional callback after parameters are updated.
   */
  handleScaleOrRangeUpdate(callback) {
    if (this.#resourcesCreated && !this.#initializationError) {
      this.updateScaleParameters(); // This updates the GPU buffer
      if (callback) callback();
      // DO NOT invalidate the layer here. Let the canvas handle it.
    }
  }

  /**
   * Helper method to update resolution (called from component's $effect)  
   * @param {Function} callback - Optional callback when resolution changes
   */
  handleResolutionChange(callback) {
    if (this.#resourcesCreated && !this.#initializationError) {
      this.updateResolution();
      if (callback) callback();
      // Note: Don't invalidate for resolution changes to avoid unnecessary redraws
    }
  }

  // ===== LAYER MANAGEMENT =====

  /**
   * Invalidate the layer's parent chart to trigger a redraw.
   */
  invalidateLayer() {
    // We no longer call a method on the layerControl itself.
    // Instead, we tell the coordinator that our parent chart is dirty.
    if (this.#gpuCoordinator && this.#chartContext?.chartId) {
        this.#gpuCoordinator.invalidateChart(this.#chartContext.chartId);
    }
  }

  /**
   * Update layer properties, obsolete?
   * @param {Object} props - Properties to update
   */
  updateLayer(props) {
    this.#ownedResources.layerControl?.update(props);
  }

  // ===== UTILITIES =====

  /**
   * Parse color string to RGBA array
   * @param {string} color - Color string (hex, named, etc.)
   * @returns {Array<number>} RGBA values [0-1]
   */
  parseColor(color) {
    try {
      if (typeof color === 'string' && color.startsWith('#')) {
        const r = parseInt(color.slice(1, 3), 16) / 255;
        const g = parseInt(color.slice(3, 5), 16) / 255;
        const b = parseInt(color.slice(5, 7), 16) / 255;
        return [r, g, b, 1.0];
      }
      console.warn(`⚠️ Unrecognized color format: ${color}, using default blue`);
      return [0.0, 0.0, 1.0, 1.0];
    } catch (error) {
      console.error(`❌ Color parsing failed for ${this.#markType}:`, error);
      return [0.0, 0.0, 1.0, 1.0];
    }
  }

  // ===== CLEANUP =====

  /**
   * Clean up all resources owned by this renderer
   */
  destroy() {
    console.log(`🧹 Cleaning up ${this.#markType} renderer resources`);
    
    try {
      // Clean up chart-specific buffers
      this.#ownedResources.buffers.forEach(buffer => {
        if (buffer && !buffer.destroyed) {
          buffer.destroy();
        }
      });
      this.#ownedResources.buffers = [];

      // Release shared resource references
      if (this.#ownedResources.pipeline && this.#gpuCoordinator) {
        this.#gpuCoordinator.releaseSharedPipeline(this.#markType);
      }
      
      if (this.#ownedResources.shader && this.#gpuCoordinator) {
        this.#gpuCoordinator.releaseSharedShader(this.#markType);
      }

      // Release shared uniform buffer reference
      if (this.#dprBuffer && !this.#ownedResources.buffers.includes(this.#dprBuffer) && this.#gpuCoordinator) {
        this.#gpuCoordinator.releaseSharedUniformBuffer('devicePixelRatio');
      }

      // Clean up layer registration
      if (this.#ownedResources.layerControl) {
        this.#ownedResources.layerControl.remove();
      }

      console.log(`✅ ${this.#markType} renderer cleanup complete`);
      
    } catch (error) {
      console.error(`❌ Error during ${this.#markType} renderer cleanup:`, error);
    }
  }
}