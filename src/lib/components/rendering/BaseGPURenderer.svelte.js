// BaseGPURenderer.svelte.js - Simplified for Pipeline Factory Pattern
// Scale management completely removed - coordinator handles all scale concerns

export class BaseGPURenderer {
  // Core properties
  #markType;
  #webGPUContext;
  #gpuCoordinator;
  #chartContext;

  // Resource tracking
  #ownedResources = {
    buffers: [],
    layerControl: null
  };

  // State management
  #resourcesCreated = $state(false);
  #initializationError = $state(null);
  #instanceCount = $state(0);

  // GPU resources - SIMPLIFIED: Only mark data + frame uniforms
  #device = null;
  #pipeline = $state(null); // Provided by coordinator factory
  
  #perFrameBindGroup = $state(null);  // @group(0): resolution, dpr
  #perDataBindGroup = $state(null);   // @group(1): mark data buffers
  
  #perFrameLayout = null;
  #perDataLayout = null;

  #dataBindingConfig = null;

  // Per-frame uniform buffers ONLY (no scale buffers)
  #resolutionBuffer = $state(null);
  #dprBuffer = $state(null);

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
    
    // Store scale types for coordinator pipeline factory
    this.#xScaleType = options.xScaleType || 'linear';
    this.#yScaleType = options.yScaleType || 'linear';
  }

  // ===== PUBLIC GETTERS =====

  get resourcesCreated() { return this.#resourcesCreated; }
  get initializationError() { return this.#initializationError; }
  get instanceCount() { return this.#instanceCount; }
  get pipeline() { return this.#pipeline; }
  get markType() { return this.#markType; }
  
  // get perFrameBindGroup() { return this.#perFrameBindGroup; }
  get perFrameBindGroup() { return null; }
  get perDataBindGroup() { return this.#perDataBindGroup; }

  // ===== INITIALIZATION =====

  async initialize(config) {
    try {
      const { dataBindingConfig, markShaderCode, vertexBufferLayout } = config;
      
      if (!dataBindingConfig) {
        throw new Error(`${this.#markType} renderer requires dataBindingConfig`);
      }

      console.log(`Initializing ${this.#markType} renderer with pipeline factory pattern`);
      
      this.#device = this.#webGPUContext.getDevice();
      if (!this.#device) {
        throw new Error('No WebGPU device available from context');
      }

      this.#dataBindingConfig = dataBindingConfig;

      // Get pipeline from coordinator factory (coordinator handles shader generation)
      await this.#getPipelineFromCoordinator(markShaderCode, vertexBufferLayout);
      
      // Create renderer-specific resources
      await this.#createRendererSpecificBuffers();
      // this.#createBindGroupLayouts();
      // this.#createPerFrameBindGroup();
      
      this.#resourcesCreated = true;
      console.log(`${this.#markType} renderer initialized - coordinator provides pipeline and scale management`);
      
    } catch (error) {
      console.error(`${this.#markType} renderer initialization failed:`, error);
      this.#initializationError = error.message;
      throw error;
    }
  }

  // ===== PIPELINE FACTORY INTEGRATION =====

  async #getPipelineFromCoordinator(markShaderCode, vertexBufferLayout) {
    const scaleTypes = {
      x: this.#chartContext.scaleTypes?.x || this.#xScaleType,
      y: this.#chartContext.scaleTypes?.y || this.#yScaleType
    };

    console.log(`Requesting pipeline from coordinator for ${this.#markType}:`, scaleTypes);

    // Use coordinator's pipeline factory
    // Get both pipeline and layouts from coordinator
    const result = await this.#gpuCoordinator.createPipelineForMarkType(
      this.#markType,
      scaleTypes,
      markShaderCode,
      vertexBufferLayout,
      this.#dataBindingConfig // Pass this so coordinator can create stable layouts
    );

    console.log('Pipeline factory result:', {
      hasPipeline: !!result.pipeline,
      hasFrameLayout: !!result.frameLayout,
      hasDataLayout: !!result.dataLayout
    });

    this.#pipeline = result.pipeline;
    this.#perFrameLayout = result.frameLayout;    // From coordinator
    this.#perDataLayout = result.dataLayout;     // From coordinator

    console.log('After assignment:', {
      pipeline: !!this.#pipeline,
      frameLayout: !!this.#perFrameLayout,
      dataLayout: !!this.#perDataLayout
    });

    if (!this.#pipeline) {
      throw new Error(`Coordinator failed to provide pipeline for ${this.#markType}`);
    }

    console.log(`Pipeline received from coordinator for ${this.#markType}`);
  }

  // ===== SIMPLIFIED BIND GROUP LAYOUTS =====

  // #createBindGroupLayouts() {
  //   // Per-frame bind group layout (@group(0))
  //   this.#perFrameLayout = this.#device.createBindGroupLayout({
  //     label: `${this.#markType}-per-frame-layout`,
  //     entries: [
  //       { 
  //         binding: 0, 
  //         visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, 
  //         buffer: { type: 'uniform' } 
  //       }, // resolution
  //       { 
  //         binding: 1, 
  //         visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, 
  //         buffer: { type: 'uniform' } 
  //       }, // devicePixelRatio
  //     ]
  //   });

  //   // Per-data bind group layout (@group(1))
  //   this.#perDataLayout = this.#device.createBindGroupLayout({
  //     label: `${this.#markType}-per-data-layout`,
  //     entries: this.#dataBindingConfig.map(config => ({
  //       binding: config.binding,
  //       visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
  //       buffer: { type: config.type || 'read-only-storage' }
  //     }))
  //   });
  // }

  // ===== RENDERER-SPECIFIC RESOURCES =====

  async #createRendererSpecificBuffers() {
    // Resolution buffer
    this.#resolutionBuffer = this.#device.createBuffer({
      size: 8, // vec2<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: `${this.#markType}-resolution-buffer`
    });
    this.#ownedResources.buffers.push(this.#resolutionBuffer);

    // Use shared DPR buffer from coordinator
    this.#dprBuffer = this.#gpuCoordinator?.getSharedUniformBuffer('devicePixelRatio');
    
    if (!this.#dprBuffer) {
      console.warn(`Creating own DPR buffer for ${this.#markType} - coordinator should provide this`);
      this.#dprBuffer = this.#device.createBuffer({
        size: 4, // f32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `${this.#markType}-dpr-buffer`
      });
      this.#device.queue.writeBuffer(this.#dprBuffer, 0, new Float32Array([this.#devicePixelRatio]));
      this.#ownedResources.buffers.push(this.#dprBuffer);
    }

    // Update initial values
    this.updateResolution();
  }

  // ===== BIND GROUP CREATION =====

  // #createPerFrameBindGroup() {
  //   if (!this.#device || !this.#perFrameLayout) {
  //     console.warn(`Cannot create per-frame bind group for ${this.#markType} - missing device or layout`);
  //     return;
  //   }

  //   if (!this.#resolutionBuffer || !this.#dprBuffer) {
  //     console.warn(`Cannot create per-frame bind group for ${this.#markType} - missing uniform buffers`);
  //     return;
  //   }

  //   try {
  //     this.#perFrameBindGroup = this.#device.createBindGroup({
  //       label: `${this.#markType}-per-frame-bind-group`,
  //       layout: this.#perFrameLayout,
  //       entries: [
  //         { binding: 0, resource: { buffer: this.#resolutionBuffer } },
  //         { binding: 1, resource: { buffer: this.#dprBuffer } },
  //       ]
  //     });

  //     console.debug(`Per-frame bind group (@group(0)) created for ${this.#markType}`);
      
  //   } catch (error) {
  //     console.error(`Failed to create per-frame bind group for ${this.#markType}:`, error);
  //     this.#initializationError = error.message;
  //     throw error;
  //   }
  // }

  createDataBindGroup(dataBindings) {
    if (!this.#device || !this.#perDataLayout) {
      console.warn(`Cannot create per-data bind group for ${this.#markType} - missing device or layout`);
      return;
    }

    if (!Array.isArray(dataBindings) || dataBindings.length === 0) {
      console.warn(`Cannot create per-data bind group for ${this.#markType} - invalid dataBindings`);
      return;
    }

    try {
      // Validate that all required bindings are provided
      const expectedBindings = this.#dataBindingConfig.map(config => config.binding);
      const providedBindings = dataBindings.map(binding => binding.binding);
      
      for (const expectedBinding of expectedBindings) {
        if (!providedBindings.includes(expectedBinding)) {
          throw new Error(`Missing data binding ${expectedBinding} for ${this.#markType}`);
        }
      }

      this.#perDataBindGroup = this.#device.createBindGroup({
        label: `${this.#markType}-per-data-bind-group`,
        layout: this.#perDataLayout,
        entries: dataBindings
      });

      console.debug(`Per-data bind group (@group(1)) created for ${this.#markType} with ${dataBindings.length} bindings`);
      
    } catch (error) {
      console.error(`Failed to create per-data bind group for ${this.#markType}:`, error);
      this.#initializationError = error.message;
      throw error;
    }
  }

  // ===== BUFFER MANAGEMENT =====

  createOrUpdateBuffer(existingBuffer, data, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) {
    if (!this.#device) {
      throw new Error('No WebGPU device available');
    }
    
    const requiredSize = data.byteLength;
    
    // Smart buffer resizing to prevent thrashing
    if (!existingBuffer || existingBuffer.size < requiredSize) {
      if (existingBuffer) {
        const index = this.#ownedResources.buffers.indexOf(existingBuffer);
        if (index !== -1) {
          this.#ownedResources.buffers.splice(index, 1);
        }
        existingBuffer.destroy();
      }

      // Smart sizing with headroom
      const MEMORY_BLOCK_SIZE = 256;
      const desiredSize = Math.ceil(requiredSize * 1.5);
      const roundedUpSize = Math.ceil(desiredSize / MEMORY_BLOCK_SIZE) * MEMORY_BLOCK_SIZE;
      let bufferSize = Math.max(requiredSize, roundedUpSize);
      bufferSize = (bufferSize + 3) & ~3; // 4-byte alignment

      const newBuffer = this.#device.createBuffer({
        size: bufferSize,
        usage,
        label: `${this.#markType}-data-buffer-${this.#ownedResources.buffers.length}`
      });
      
      this.#ownedResources.buffers.push(newBuffer);
      console.debug(`Created ${this.#markType} buffer of size ${bufferSize} bytes (required: ${requiredSize})`);
      return newBuffer;
    }
    
    return existingBuffer;
  }

  updateInstanceCount(count) {
    this.#instanceCount = count;
    this.invalidateLayer();
  }

  // ===== RESOLUTION MANAGEMENT =====

  updateResolution() {
    if (!this.#resolutionBuffer) return;

    try {
      const device = this.#webGPUContext.getDevice();
      if (!device) return;

      const { width, height } = this.#webGPUContext.getCanvasDimensions();
      device.queue.writeBuffer(this.#resolutionBuffer, 0, new Float32Array([width, height]));
      
    } catch (error) {
      console.error(`Failed to update resolution for ${this.#markType}:`, error);
    }
  }

  handleResolutionChange(callback) {
    if (this.#resourcesCreated && !this.#initializationError) {
      this.updateResolution();
      if (callback) callback();
    }
  }

  // ===== DEPRECATED METHODS =====

  // Scale management completely removed - coordinator handles all scale concerns
  handleScaleOrRangeUpdate(callback) {
    console.warn(`[${this.#markType}] handleScaleOrRangeUpdate is deprecated - coordinator manages scale updates directly`);
    if (callback) callback();
  }

  // Legacy getter for transition period
  get bindGroup() { 
    console.warn(`[${this.#markType}] bindGroup getter is deprecated. Use perFrameBindGroup and perDataBindGroup instead.`);
    return this.#perFrameBindGroup;
  }

  // ===== LAYER MANAGEMENT =====

  registerLayer(drawFunction) {
    try {
      const chartId = this.#chartContext.chartId;

      const layerConfig = {
        draw: drawFunction,
        markType: this.#markType,
        renderer: this, 
        componentId: `${this.#markType}-${crypto.randomUUID().slice(0, 6)}`
      };

      this.#ownedResources.layerControl = this.#gpuCoordinator.registerLayer(chartId, layerConfig);

      console.log(`${this.#markType} layer registered with coordinator for chart ${chartId}`);
      return this.#ownedResources.layerControl;

    } catch (error) {
      console.error(`${this.#markType} layer registration failed:`, error);
      this.#initializationError = error.message;
      throw error;
    }
  }

  invalidateLayer() {
    if (this.#gpuCoordinator && this.#chartContext?.chartId) {
      this.#gpuCoordinator.invalidateChart(this.#chartContext.chartId);
    }
  }

  // ===== DATA PROCESSING HELPERS =====

  processDataForAxis(data, axis) {
    const scaleType = axis === 'x' ? this.#xScaleType : this.#yScaleType;
    const scaleState = axis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;

    switch (scaleType) {
      case 'linear':
      case 'identity':
        return new Float32Array(data.map(d => d ?? 0));
        
      case 'band':
      case 'point':
        return scaleState.processDataForGPU(data, this.#markType);
        
      case 'log':
        return new Float32Array(data.map(d => Math.log(Math.max(d || 1, 1))));
        
      case 'time':
        return new Float32Array(data.map(d => d instanceof Date ? d.getTime() : d || 0));
        
      default:
        console.warn(`Unknown scale type: ${scaleType}, treating as linear`);
        return new Float32Array(data.map(d => d ?? 0));
    }
  }

  // ===== UTILITY METHODS =====

  parseColor(color) {
    try {
      if (typeof color === 'string' && color.startsWith('#')) {
        const r = parseInt(color.slice(1, 3), 16) / 255;
        const g = parseInt(color.slice(3, 5), 16) / 255;
        const b = parseInt(color.slice(5, 7), 16) / 255;
        return [r, g, b, 1.0];
      }
      console.warn(`Unrecognized color format: ${color}, using default blue`);
      return [0.0, 0.0, 1.0, 1.0];
    } catch (error) {
      console.error(`Color parsing failed for ${this.#markType}:`, error);
      return [0.0, 0.0, 1.0, 1.0];
    }
  }

  // ===== CLEANUP =====

  destroy() {
    console.log(`Cleaning up ${this.#markType} renderer resources`);
    
    try {
      // Clean up owned buffers
      this.#ownedResources.buffers.forEach(buffer => {
        if (buffer && !buffer.destroyed) {
          buffer.destroy();
        }
      });
      this.#ownedResources.buffers = [];

      // Release shared DPR buffer reference if coordinator provided it
      if (this.#dprBuffer && !this.#ownedResources.buffers.includes(this.#dprBuffer) && this.#gpuCoordinator) {
        this.#gpuCoordinator.releaseSharedUniformBuffer('devicePixelRatio');
      }

      // Clean up layer registration
      if (this.#ownedResources.layerControl) {
        this.#ownedResources.layerControl.remove();
      }

      console.log(`${this.#markType} renderer cleanup complete`);
      
    } catch (error) {
      console.error(`Error during ${this.#markType} renderer cleanup:`, error);
    }
  }
}