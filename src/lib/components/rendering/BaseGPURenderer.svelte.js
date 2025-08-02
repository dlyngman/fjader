/**
 * Base class for GPU-based renderers that handles common patterns:
 * - Resource lifecycle management
 * - Buffer creation and updates
 * - Scale parameter management with universal scale support
 * - GPU coordinator integration
 * - Error handling and cleanup
 * 
 * UPDATED: Now supports dual bind group architecture for performance optimization
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
  
  // ✅ NEW: Dual bind group architecture
  #perFrameBindGroup = $state(null);  // Hot path: uniforms that change every frame
  #perDataBindGroup = $state(null);   // Cold path: data buffers that change rarely
  #perScaleBindGroup = $state(null);
  
  // ✅ NEW: Bind group layouts (stored for recreation)
  #perFrameLayout = null;
  #perDataLayout = null;
  #perScaleLayout = null;

  #xCategoryPositionsBuffer = $state(null);
  #yCategoryPositionsBuffer = $state(null);

  #dataBindingConfig = null;  // Store config for later use

  // Existing uniform buffers
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
   * 
   * ✅ UPDATED: Updated binding indices for dual bind group architecture
   */
  // static getScaleShaderFragment() {
  //   return `
  //     struct ScaleParams {
  //       domainMin: vec2<f32>,       // [0-1] Domain minimums
  //       domainMax: vec2<f32>,       // [2-3] Domain maximums
  //       rangeMin: vec2<f32>,        // [4-5] Range minimums
  //       rangeMax: vec2<f32>,        // [6-7] Range maximums
  //       scaleTypes: vec2<f32>,      // [8-9] Scale type constants (0=linear, 1=band, 3=identity)
  //       bandwidth: vec2<f32>,       // [10-11] Band scale bandwidths
  //       padding: vec2<f32>,         // [12-13] Band scale padding
  //       categoryCount: vec2<f32>,   // [14-15] Number of categories for band scales

  //       // Pre-computed optimization values
  //       domainScale: vec2<f32>,     // 1.0 / (domainMax - domainMin)
  //       rangeSize: vec2<f32>,       // rangeMax - rangeMin
        
  //       // Padding to ensure 128-byte alignment, ready for future use
  //       padding_0: vec2<f32>,
  //       padding_1: vec2<f32>,
  //       padding_2: vec2<f32>,
  //       padding_3: vec2<f32>,
  //       padding_4: vec2<f32>,
  //       padding_5: vec2<f32>,
  //     };

  //     // Universal scaling function that handles all scale types
  //     fn scaleValue(
  //       value: f32, 
  //       scaleType: f32,
  //       domainMin: f32, 
  //       domainScale: f32,
  //       rangeMin: f32, 
  //       rangeSize: f32,
  //       bandwidth: f32,
  //       categoryCount: f32
  //     ) -> f32 {
  //       if (scaleType == 0.0) {
  //         // Linear scale
  //         let normalized = (value - domainMin) * domainScale;
  //         return rangeMin + normalized * rangeSize;
          
  //       } else if (scaleType == 1.0) {
  //         // Band scale: value is category index, position at center of band
  //         let categoryIndex = floor(value);
  //         let step = rangeSize / categoryCount;
          
  //         // Position at center of the band
  //         return rangeMin + categoryIndex * step + bandwidth * 0.5;
          
  //       } else if (scaleType == 2.0) {
  //         // Point scale: evenly distributed points
  //         let categoryIndex = floor(value);
  //         let step = rangeSize / max(1.0, categoryCount - 1.0);
          
  //         return rangeMin + categoryIndex * step;
          
  //       } else if (scaleType == 3.0) {
  //         // Identity scale: pass through (for pixel coordinates)
  //         return value;
          
  //       }
        
  //       // Fallback to linear for unknown scale types
  //       let normalized = (value - domainMin) * domainScale;
  //       return rangeMin + normalized * rangeSize;
  //     }

  //     // Convenience functions for X and Y axes - components call these
  //     fn scaleX(value: f32, scaleParams: ScaleParams) -> f32 {
  //       return scaleValue(
  //         value,
  //         scaleParams.scaleTypes.x,
  //         scaleParams.domainMin.x,
  //         scaleParams.domainScale.x,
  //         scaleParams.rangeMin.x,
  //         scaleParams.rangeSize.x,
  //         scaleParams.bandwidth.x,
  //         scaleParams.categoryCount.x
  //       );
  //     }

  //     fn scaleY(value: f32, scaleParams: ScaleParams) -> f32 {
  //       return scaleValue(
  //         value,
  //         scaleParams.scaleTypes.y,
  //         scaleParams.domainMin.y,
  //         scaleParams.domainScale.y,
  //         scaleParams.rangeMin.y,
  //         scaleParams.rangeSize.y,
  //         scaleParams.bandwidth.y,
  //         scaleParams.categoryCount.y
  //       );
  //     }
  //   `;
  // }
  static getScaleShaderFragment() {
    return `
      struct ScaleParams {
        domainMin: vec2<f32>,       // [0-1] Domain minimums
        domainMax: vec2<f32>,       // [2-3] Domain maximums
        rangeMin: vec2<f32>,        // [4-5] Range minimums
        rangeMax: vec2<f32>,        // [6-7] Range maximums
        scaleTypes: vec2<f32>,      // [8-9] Scale type constants (0=linear, 1=band, 2=point, 3=identity)
        bandwidth: vec2<f32>,       // [10-11] Band scale bandwidths (per-chart)
        categoryCount: vec2<f32>,   // [12-13] Number of categories for band scales
        
        // Pre-computed optimization values
        domainScale: vec2<f32>,     // [14-15] 1.0 / (domainMax - domainMin)
        rangeSize: vec2<f32>,       // [16-17] rangeMax - rangeMin
        
        // Padding to ensure 128-byte alignment, ready for future use
        padding_0: vec2<f32>,       // [18-19]
        padding_1: vec2<f32>,       // [20-21]
        padding_2: vec2<f32>,       // [22-23]
        padding_3: vec2<f32>,       // [24-25]
        padding_4: vec2<f32>,       // [26-27]
        padding_5: vec2<f32>,       // [28-29]
        padding_6: vec2<f32>,       // [30-31]
      };

      // ✅ NEW: Enhanced scale result with bandwidth info
      struct ScaleResult {
        position: f32,
        bandwidth: f32,  // 0 for linear scales, actual bandwidth for band scales
      };

      // ✅ NEW: Universal scaling function with 3-bind-group support
      fn scaleValueDetailed(
        value: f32, 
        scaleType: f32,
        domainMin: f32, 
        domainScale: f32,
        rangeMin: f32, 
        rangeSize: f32,
        bandwidth: f32,
        categoryCount: f32,
        categoryPositions: ptr<storage, array<f32>>
      ) -> ScaleResult {
        if (scaleType == 0.0) {
          // Linear scale
          let normalized = (value - domainMin) * domainScale;
          return ScaleResult(
            rangeMin + normalized * rangeSize,
            0.0  // No bandwidth for linear scales
          );
          
        } else if (scaleType == 1.0) {
          // Band scale: use pre-computed category positions from @group(2)
          let categoryIndex = u32(floor(clamp(value, 0.0, categoryCount - 1.0)));
          let position = (*categoryPositions)[categoryIndex];  // Pre-computed pixel position
          
          return ScaleResult(
            position,
            bandwidth
          );
          
        } else if (scaleType == 2.0) {
          // Point scale: use pre-computed positions (center points)
          let categoryIndex = u32(floor(clamp(value, 0.0, categoryCount - 1.0)));
          let position = (*categoryPositions)[categoryIndex];
          
          return ScaleResult(
            position,
            0.0  // Points don't have bandwidth
          );
          
        } else if (scaleType == 3.0) {
          // Identity scale: pass through
          return ScaleResult(value, 0.0);
        }
        
        // Fallback to linear
        let normalized = (value - domainMin) * domainScale;
        return ScaleResult(
          rangeMin + normalized * rangeSize,
          0.0
        );
      }

      // ✅ NEW: Convenience functions accessing @group(2) category positions
      fn scaleXDetailed(value: f32, scaleParams: ScaleParams) -> ScaleResult {
        return scaleValueDetailed(
          value,
          scaleParams.scaleTypes.x,
          scaleParams.domainMin.x,
          scaleParams.domainScale.x,
          scaleParams.rangeMin.x,
          scaleParams.rangeSize.x,
          scaleParams.bandwidth.x,
          scaleParams.categoryCount.x,
          &xCategoryPositions  // References @group(2) @binding(0)
        );
      }

      fn scaleYDetailed(value: f32, scaleParams: ScaleParams) -> ScaleResult {
        return scaleValueDetailed(
          value,
          scaleParams.scaleTypes.y,
          scaleParams.domainMin.y,
          scaleParams.domainScale.y,
          scaleParams.rangeMin.y,
          scaleParams.rangeSize.y,
          scaleParams.bandwidth.y,
          scaleParams.categoryCount.y,
          &yCategoryPositions  // References @group(2) @binding(1)
        );
      }

      // ✅ NEW: Simple convenience functions (return center for bands)
      fn scaleX(value: f32, scaleParams: ScaleParams) -> f32 {
        let result = scaleXDetailed(value, scaleParams);
        if (scaleParams.scaleTypes.x == 1.0) {
          return result.position + result.bandwidth * 0.5; // Center for bands
        }
        return result.position; // Exact position for linear
      }

      fn scaleY(value: f32, scaleParams: ScaleParams) -> f32 {
        let result = scaleYDetailed(value, scaleParams);
        if (scaleParams.scaleTypes.y == 1.0) {
          return result.position + result.bandwidth * 0.5; // Center for bands
        }
        return result.position; // Exact position for linear
      }
    `;
  }

  /**
   * Get standard binding constants for dual bind group architecture
   * 
   * ✅ UPDATED: New binding layout for performance optimization
   */
  // static getStandardBindings() {
  //   return {
  //     // @group(0) - Per-Frame Group (hot path - changes every frame)
  //     FRAME_RESOLUTION: 0,
  //     FRAME_SCALE_PARAMS: 1,
  //     FRAME_DEVICE_PIXEL_RATIO: 2,
      
  //     // @group(1) - Per-Data Group (cold path - changes when data updates)
  //     // Data bindings 0-N are component-specific and configured via dataBindingConfig
  //   };
  // }
  static getStandardBindings() {
    return {
      // @group(0) - Per-Frame Group (hot path - changes every frame)
      FRAME_RESOLUTION: 0,
      FRAME_SCALE_PARAMS: 1,
      FRAME_DEVICE_PIXEL_RATIO: 2,
      
      // @group(1) - Per-Data Group (cold path - changes when data updates)
      // Data bindings 0-N are component-specific and configured via dataBindingConfig
      
      // @group(2) - Per-Scale Group (shared scale data)
      SCALE_X_CATEGORY_POSITIONS: 0,
      SCALE_Y_CATEGORY_POSITIONS: 1,
    };
  }

  /**
   * Generate complete shader code by combining scale fragment with component code
   * This is the main function components use to get their complete shader
   * 
   * ✅ UPDATED: Now includes proper group annotations for dual bind group architecture
   */
  // static generateShader(componentSpecificCode) {
  //   const scaleFragment = BaseGPURenderer.getScaleShaderFragment();
    
  //   return `
  //     ${scaleFragment}
      
  //     // Standard per-frame uniforms (@group(0))
  //     @group(0) @binding(0) var<uniform> resolution: vec2<f32>;
  //     @group(0) @binding(1) var<uniform> scaleParams: ScaleParams;
  //     @group(0) @binding(2) var<uniform> devicePixelRatio: f32;
      
  //     ${componentSpecificCode}
  //   `;
  // }
  static generateShader(componentSpecificCode) {
    const scaleFragment = BaseGPURenderer.getScaleShaderFragment();
    
    return `
      ${scaleFragment}
      
      // @group(0) - Per-frame uniforms (hot path)
      @group(0) @binding(0) var<uniform> resolution: vec2<f32>;
      @group(0) @binding(1) var<uniform> scaleParams: ScaleParams;
      @group(0) @binding(2) var<uniform> devicePixelRatio: f32;
      
      // @group(2) - Per-scale shared data (category positions)
      @group(2) @binding(0) var<storage, read> xCategoryPositions: array<f32>;
      @group(2) @binding(1) var<storage, read> yCategoryPositions: array<f32>;
      
      ${componentSpecificCode}
    `;
  }

  // ===== PUBLIC GETTERS =====

  get resourcesCreated() { return this.#resourcesCreated; }
  get initializationError() { return this.#initializationError; }
  get instanceCount() { return this.#instanceCount; }
  get pipeline() { return this.#pipeline; }
  get markType() { return this.#markType; }
  
  // ✅ NEW: Dual bind group getters
  get perFrameBindGroup() { return this.#perFrameBindGroup; }
  get perDataBindGroup() { return this.#perDataBindGroup; }
  get perScaleBindGroup() { return this.#perScaleBindGroup; }
  
  // ✅ DEPRECATED: Legacy getter for backward compatibility during transition
  get bindGroup() { 
    console.warn(`❌ [${this.#markType}] bindGroup getter is deprecated. Use perFrameBindGroup and perDataBindGroup instead.`);
    return this.#perFrameBindGroup; // Return frame group as fallback
  }

  // ===== INITIALIZATION =====

  /**
   * Initialize the renderer with shape-specific configuration
   * 
   * ✅ UPDATED: Now requires dataBindingConfig for dual bind group architecture
   * 
   * @param {Object} config - Shape-specific configuration
   * @param {string} config.shaderCode - WGSL shader code (should be generated with generateShader)
   * @param {Array} config.vertexBufferLayout - Vertex buffer layout configuration
   * @param {Array} config.dataBindingConfig - Data binding configuration for @group(1)
   */
  async initialize(config) {
    try {
      const { dataBindingConfig, shaderCode, vertexBufferLayout } = config;
      
      if (!dataBindingConfig) {
        throw new Error(`${this.#markType} renderer requires dataBindingConfig for dual bind group architecture`);
      }
      
      if (!Array.isArray(dataBindingConfig)) {
        throw new Error(`${this.#markType} renderer dataBindingConfig must be an array`);
      }

      console.log(`🔧 Initializing ${this.#markType} renderer with dual bind group architecture`);
      
      this.#device = this.#webGPUContext.getDevice();
      if (!this.#device) {
        throw new Error('No WebGPU device available from context');
      }

      // Store config for later use
      this.#dataBindingConfig = dataBindingConfig;

      await this.#createSharedResources(this.#device, config);
      await this.#createCommonBuffers(this.#device);
      
      // ✅ NEW: Auto-create per-frame bind group (it's consistent across all marks)
      this.#createPerFrameBindGroup();
      this.#createPerScaleBindGroup();
      
      this.#resourcesCreated = true;
      console.log(`✅ ${this.#markType} renderer initialized successfully with dual bind groups`);
      
    } catch (error) {
      console.error(`❌ ${this.#markType} renderer initialization failed:`, error);
      this.#initializationError = error.message;
      throw error;
    }
  }

  // ===== NEW: BIND GROUP LAYOUT CREATION =====

  /**
   * Create bind group layouts for dual bind group architecture
   * 
   * @param {GPUDevice} device - WebGPU device
   * @param {Array} dataBindingConfig - Configuration for data bindings
   * @returns {Object} Object containing perFrameLayout and perDataLayout
   */
  #createBindGroupLayouts(device, dataBindingConfig) {
    // Per-frame bind group layout (consistent across all marks)
    const perFrameLayout = device.createBindGroupLayout({
      label: `${this.#markType}-per-frame-layout`,
      entries: [
        { 
          binding: 0, 
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, 
          buffer: { type: 'uniform' } 
        }, // resolution
        { 
          binding: 1, 
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, 
          buffer: { type: 'uniform' } 
        }, // scaleParams
        { 
          binding: 2, 
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, 
          buffer: { type: 'uniform' } 
        }, // devicePixelRatio
      ]
    });

    // Per-data bind group layout (varies by mark type)
    const perDataLayout = device.createBindGroupLayout({
      label: `${this.#markType}-per-data-layout`,
      entries: dataBindingConfig.map(config => ({
        binding: config.binding,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: config.type || 'read-only-storage' }
      }))
    });

    // Per-scale layout (shared scale data)
    const perScaleLayout = device.createBindGroupLayout({
      label: `${this.#markType}-per-scale-layout`,
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }, // xCategoryPositions
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }, // yCategoryPositions
      ]
    });

    return { perFrameLayout, perDataLayout, perScaleLayout };
  }

  // ===== UPDATED: SHARED RESOURCE MANAGEMENT =====

  async #createSharedResources(device, config) {
    if (!this.#gpuCoordinator) {
      throw new Error('GPU coordinator not available');
    }

    // ✅ NEW: Create bind group layouts
    const { perFrameLayout, perDataLayout, perScaleLayout } = this.#createBindGroupLayouts(device, config.dataBindingConfig);
    this.#perFrameLayout = perFrameLayout;
    this.#perDataLayout = perDataLayout;
    this.#perScaleLayout = perScaleLayout;

    // Create or get shared shader
    const shaderModule = await this.#gpuCoordinator.getOrCreateSharedShader(
      this.#markType, 
      config.shaderCode
    );
    this.#ownedResources.shader = true;

    // Create pipeline with 3-bind-group layout
    const pipelineLayout = device.createPipelineLayout({
      label: `${this.#markType}-pipeline-layout`,
      bindGroupLayouts: [perFrameLayout, perDataLayout, perScaleLayout]
    });

    this.#pipeline = await this.#gpuCoordinator.getOrCreateSharedPipeline(
      this.#markType, 
      async () => {
        const msaaSampleCount = this.#webGPUContext.getMsaaSampleCount();

        return device.createRenderPipeline({
          label: `${this.#markType}-pipeline`,
          layout: pipelineLayout,
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

  async #createCategoryPositionBuffers(device) {
    // Create buffers with reasonable initial size (will resize as needed)
    const initialSize = 4 * 256; // 256 categories initial capacity

    this.#xCategoryPositionsBuffer = device.createBuffer({
      size: initialSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: `${this.#markType}-x-category-positions`
    });
    this.#ownedResources.buffers.push(this.#xCategoryPositionsBuffer);

    this.#yCategoryPositionsBuffer = device.createBuffer({
      size: initialSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: `${this.#markType}-y-category-positions`
    });
    this.#ownedResources.buffers.push(this.#yCategoryPositionsBuffer);

    // Write initial empty data
    device.queue.writeBuffer(this.#xCategoryPositionsBuffer, 0, new Float32Array(256));
    device.queue.writeBuffer(this.#yCategoryPositionsBuffer, 0, new Float32Array(256));

    console.log(`📊 Created category position buffers for ${this.#markType} (256 category initial capacity)`);
  }

  async #createCommonBuffers(device) {
    // Create chart-specific uniform buffers
    this.#resolutionBuffer = device.createBuffer({
      size: 8, // vec2<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: `${this.#markType}-resolution-buffer`
    });
    this.#ownedResources.buffers.push(this.#resolutionBuffer);

    this.#scaleParamsBuffer = device.createBuffer({
      size: 128, // 16 f32 values for enhanced scale parameters
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: `${this.#markType}-scale-params-buffer`
    });
    this.#ownedResources.buffers.push(this.#scaleParamsBuffer);

    // Use shared DPR buffer if available, create own if needed
    this.#dprBuffer = this.#gpuCoordinator?.getSharedUniformBuffer('devicePixelRatio');
    
    if (!this.#dprBuffer) {
      console.warn(`🔶 Creating own DPR buffer for ${this.#markType} - coordinator should provide this`);
      this.#dprBuffer = device.createBuffer({
        size: 4, // f32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `${this.#markType}-dpr-buffer`
      });
      device.queue.writeBuffer(this.#dprBuffer, 0, new Float32Array([this.#devicePixelRatio]));
      this.#ownedResources.buffers.push(this.#dprBuffer);
    }

    await this.#createCategoryPositionBuffers(device);

    // Update initial values
    this.updateResolution();
    this.updateScaleParameters();
    this.updateCategoryPositions();
  }

  // ===== NEW: DUAL BIND GROUP CREATION =====

  /**
   * Create the per-frame bind group (internal method)
   * This contains uniforms that change frequently (every frame during pan/zoom)
   * Called automatically after buffer creation
   */
  #createPerFrameBindGroup() {
    if (!this.#device || !this.#perFrameLayout) {
      console.warn(`⚠️ Cannot create per-frame bind group for ${this.#markType} - missing device or layout`);
      return;
    }

    if (!this.#resolutionBuffer || !this.#scaleParamsBuffer || !this.#dprBuffer) {
      console.warn(`⚠️ Cannot create per-frame bind group for ${this.#markType} - missing uniform buffers`);
      return;
    }

    try {
      this.#perFrameBindGroup = this.#device.createBindGroup({
        label: `${this.#markType}-per-frame-bind-group`,
        layout: this.#perFrameLayout,
        entries: [
          { binding: 0, resource: { buffer: this.#resolutionBuffer } },
          { binding: 1, resource: { buffer: this.#scaleParamsBuffer } },
          { binding: 2, resource: { buffer: this.#dprBuffer } },
        ]
      });

      console.debug(`✅ Per-frame bind group created for ${this.#markType}`);
      
    } catch (error) {
      console.error(`❌ Failed to create per-frame bind group for ${this.#markType}:`, error);
      this.#initializationError = error.message;
      throw error;
    }
  }

  #createPerScaleBindGroup() {
    if (!this.#device || !this.#perScaleLayout) {
      console.warn(`⚠️ Cannot create per-scale bind group for ${this.#markType} - missing device or layout`);
      return;
    }

    if (!this.#xCategoryPositionsBuffer || !this.#yCategoryPositionsBuffer) {
      console.warn(`⚠️ Cannot create per-scale bind group for ${this.#markType} - missing category position buffers`);
      return;
    }

    try {
      this.#perScaleBindGroup = this.#device.createBindGroup({
        label: `${this.#markType}-per-scale-bind-group`,
        layout: this.#perScaleLayout,
        entries: [
          { binding: 0, resource: { buffer: this.#xCategoryPositionsBuffer } },
          { binding: 1, resource: { buffer: this.#yCategoryPositionsBuffer } },
        ]
      });

      console.debug(`✅ Per-scale bind group (@group(2)) created for ${this.#markType}`);
      
    } catch (error) {
      console.error(`❌ Failed to create per-scale bind group for ${this.#markType}:`, error);
      this.#initializationError = error.message;
      throw error;
    }
  }

  // updateCategoryPositions() {
  //   if (!this.#device || !this.#xCategoryPositionsBuffer || !this.#yCategoryPositionsBuffer) {
  //     return;
  //   }

  //   try {
  //     const xPositions = this.#chartContext.xCategoryPositions;
  //     const yPositions = this.#chartContext.yCategoryPositions;

  //     console.log('🔍 Category positions update:', {
  //       xPositions: xPositions?.length || 0,
  //       yPositions: yPositions?.length || 0,
  //       scaleTypes: this.#chartContext.scaleTypes
  //     });

  //     // Update X category positions
  //     if (xPositions && xPositions.length > 0) {
  //       // Resize buffer if needed
  //       if (xPositions.byteLength > this.#xCategoryPositionsBuffer.size) {
  //         this.#resizeCategoryPositionBuffer('x', xPositions.byteLength);
  //       }
  //       this.#device.queue.writeBuffer(this.#xCategoryPositionsBuffer, 0, xPositions);
  //     }

  //     // Update Y category positions
  //     if (yPositions && yPositions.length > 0) {
  //       // Resize buffer if needed
  //       if (yPositions.byteLength > this.#yCategoryPositionsBuffer.size) {
  //         this.#resizeCategoryPositionBuffer('y', yPositions.byteLength);
  //       }
  //       this.#device.queue.writeBuffer(this.#yCategoryPositionsBuffer, 0, yPositions);
  //     }
      
  //   } catch (error) {
  //     console.error(`❌ Failed to update category positions for ${this.#markType}:`, error);
  //   }
  // }
  updateCategoryPositions() {
    if (!this.#device || !this.#xCategoryPositionsBuffer || !this.#yCategoryPositionsBuffer) {
      return;
    }

    try {
      const xPositions = this.#chartContext.xCategoryPositions;
      const yPositions = this.#chartContext.yCategoryPositions;
      
      // ✅ FIX: Provide fallback positions for linear scales
      const defaultPositions = new Float32Array([0]);

      // Update X category positions 
      const finalXPositions = xPositions?.length > 0 ? xPositions : defaultPositions;
      this.#device.queue.writeBuffer(this.#xCategoryPositionsBuffer, 0, finalXPositions);

      // Update Y category positions
      const finalYPositions = yPositions?.length > 0 ? yPositions : defaultPositions;
      this.#device.queue.writeBuffer(this.#yCategoryPositionsBuffer, 0, finalYPositions);

      console.log('✅ Category positions updated:', {
        xLength: finalXPositions.length,
        yLength: finalYPositions.length
      });
      
    } catch (error) {
      console.error(`❌ Category positions update failed:`, error);
    }
  }

  #resizeCategoryPositionBuffer(axis, newByteLength) {
    const device = this.#device;
    if (!device) return;

    const isX = axis === 'x';
    const oldBuffer = isX ? this.#xCategoryPositionsBuffer : this.#yCategoryPositionsBuffer;
    
    // Create larger buffer with some headroom
    const newSize = Math.max(newByteLength * 1.5, 1024); // At least 1KB, 50% headroom
    const newBuffer = device.createBuffer({
      size: newSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: `${this.#markType}-${axis}-category-positions-resized`
    });

    // Update references
    if (isX) {
      this.#xCategoryPositionsBuffer = newBuffer;
    } else {
      this.#yCategoryPositionsBuffer = newBuffer;
    }

    // Remove old buffer from tracking and destroy it
    const index = this.#ownedResources.buffers.indexOf(oldBuffer);
    if (index !== -1) {
      this.#ownedResources.buffers.splice(index, 1);
    }
    oldBuffer.destroy();

    // Add new buffer to tracking
    this.#ownedResources.buffers.push(newBuffer);

    // Recreate per-scale bind group with new buffer
    this.#createPerScaleBindGroup();

    console.log(`📊 Resized ${axis}-category buffer for ${this.#markType}: ${newSize} bytes`);
  }

  /**
   * Create the per-data bind group (public method)
   * This contains storage buffers that change only when data updates
   * Called by mark components when their data buffers are ready
   * 
   * @param {Array} dataBindings - Array of binding entries for data buffers
   */
  createDataBindGroup(dataBindings) {
    if (!this.#device || !this.#perDataLayout) {
      console.warn(`⚠️ Cannot create per-data bind group for ${this.#markType} - missing device or layout`);
      return;
    }

    if (!Array.isArray(dataBindings) || dataBindings.length === 0) {
      console.warn(`⚠️ Cannot create per-data bind group for ${this.#markType} - invalid dataBindings`);
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

      console.debug(`✅ Per-data bind group created for ${this.#markType} with ${dataBindings.length} bindings`);
      
    } catch (error) {
      console.error(`❌ Failed to create per-data bind group for ${this.#markType}:`, error);
      this.#initializationError = error.message;
      throw error;
    }
  }

  /**
   * Recreate the per-frame bind group
   * Called when uniform buffers are recreated or need updating
   */
  recreatePerFrameBindGroup() {
    this.#createPerFrameBindGroup();
  }

  // ===== DEPRECATED: LEGACY BIND GROUP METHOD =====

  /**
   * @deprecated Legacy method for backward compatibility
   * Use createDataBindGroup() instead for new dual bind group architecture
   */
  createBindGroup(additionalBindings = []) {
    console.warn(`❌ [${this.#markType}] createBindGroup() is deprecated. Use createDataBindGroup() for dual bind group architecture.`);
    
    // For backward compatibility, assume additionalBindings are data bindings
    if (additionalBindings.length > 0) {
      this.createDataBindGroup(additionalBindings);
    }
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
        label: `${this.#markType}-data-buffer-${this.#ownedResources.buffers.length}`
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
  // updateScaleParameters() {
  //   if (!this.#device || !this.#scaleParamsBuffer || !this.#chartContext) {
  //     return;
  //   }

  //   try {
  //     const c = this.#chartContext;
  //     const scaleParams = this.#scaleParamsArray;

  //     const xScaleState = c.xScaleState;
  //     const yScaleState = c.yScaleState;
  //     const scaleTypes = c.scaleTypes;

  //     if (!xScaleState || !yScaleState || !scaleTypes) return;

  //     const xGpuState = xScaleState.gpuState;
  //     const yGpuState = yScaleState.gpuState;

  //     // ---- Indices 0-7: Core Domain & Range ----
  //     scaleParams[0] = xGpuState.domainMin;
  //     scaleParams[1] = yGpuState.domainMin;
  //     scaleParams[2] = xGpuState.domainMax;
  //     scaleParams[3] = yGpuState.domainMax;
  //     scaleParams[4] = 0;
  //     scaleParams[5] = c.innerHeight;
  //     scaleParams[6] = c.innerWidth;
  //     scaleParams[7] = 0;

  //     // ---- Indices 8-15: Scale Type & Categorical Info ----
  //     scaleParams[8] = this.#getGPUScaleType(scaleTypes.x);
  //     scaleParams[9] = this.#getGPUScaleType(scaleTypes.y);
  //     scaleParams[10] = c.xScale.bandwidth?.() ?? 0; // Get directly from state class
  //     // scaleParams[10] = xScaleState.bandwidth ?? 0; // Get directly from state class
  //     scaleParams[11] = c.yScale.bandwidth?.() ?? 0;
  //     // console.log('y scale bandwidth', scaleParams[10])
  //     // scaleParams[11] = yScaleState.bandwidth ?? 0;
  //     scaleParams[12] = xScaleState.padding ?? 0;   // Assumes `padding` getter exists
  //     scaleParams[13] = yScaleState.padding ?? 0;
  //     scaleParams[14] = xGpuState.categoryCount;
  //     scaleParams[15] = yGpuState.categoryCount;

  //     // ---- Indices 16-23: Pre-computed Factors for Optimization ----
  //     // Get the pre-calculated domain scale factor (1 / (max - min))
  //     scaleParams[16] = xGpuState.domainScale ?? 0;
  //     scaleParams[17] = yGpuState.domainScale ?? 0;

  //     // Pre-calculate the range width/height
  //     scaleParams[18] = c.innerWidth;
  //     scaleParams[19] = -c.innerHeight;

  //     // The remaining slots (20-31) are reserved for future use (e.g., rangeScale factors)
  //     // It's good practice to zero them out.
  //     scaleParams.fill(0, 20);

  //     // Final, single write to the GPU command queue.
  //     this.#device.queue.writeBuffer(this.#scaleParamsBuffer, 0, scaleParams);

  //     console.log('🔍 Scale Parameters sent to GPU:', {
  //       // Domain values
  //       xDomain: [scaleParams[0], scaleParams[2]], // domainMin.x, domainMax.x
  //       yDomain: [scaleParams[1], scaleParams[3]], // domainMin.y, domainMax.y
        
  //       // Range values  
  //       xRange: [scaleParams[4], scaleParams[6]], // rangeMin.x, rangeMax.x
  //       yRange: [scaleParams[5], scaleParams[7]], // rangeMin.y, rangeMax.y
        
  //       // Scale types
  //       xScaleType: scaleParams[8], // Should be 0 for linear
  //       yScaleType: scaleParams[9], // Should be 0 for linear
        
  //       // Pre-computed factors
  //       xDomainScale: scaleParams[14], // 1/(domainMax-domainMin)
  //       yDomainScale: scaleParams[15],
  //       xRangeSize: scaleParams[16],
  //       yRangeSize: scaleParams[17],
        
  //       // Chart dimensions for reference
  //       innerWidth: c.innerWidth,
  //       innerHeight: c.innerHeight
  //     });
        
  //   } catch (error) {
  //     console.error(`❌ Failed to update scale parameters for ${this.#markType}:`, error);
  //   }
  // }

  /**
 * Updates the GPU's uniform buffer with all necessary scale parameters.
 * ✅ CORRECTED: Fixed indices to match shader struct exactly
 */
  updateScaleParameters() {
    if (!this.#device || !this.#scaleParamsBuffer || !this.#chartContext) {
      return;
    }
    console.log('updateScaleParameters')

    try {
      const c = this.#chartContext;
      const scaleParams = this.#scaleParamsArray;

      const xScaleState = c.xScaleState;
      const yScaleState = c.yScaleState;
      const scaleTypes = c.scaleTypes;

      if (!xScaleState || !yScaleState || !scaleTypes) return;

      const xGpuState = xScaleState.gpuState;
      const yGpuState = yScaleState.gpuState;
      
      // ---- Indices 0-3: Domain Min/Max ----
      scaleParams[0] = xGpuState.domainMin;              // domainMin.x
      scaleParams[1] = yGpuState.domainMin;              // domainMin.y
      scaleParams[2] = xGpuState.domainMax;              // domainMax.x
      scaleParams[3] = yGpuState.domainMax;              // domainMax.y

      // ---- Indices 4-7: Range Min/Max ----
      scaleParams[4] = 0;                                // rangeMin.x
      scaleParams[5] = c.innerHeight;                    // rangeMin.y (bottom of screen)
      scaleParams[6] = c.innerWidth;                     // rangeMax.x
      scaleParams[7] = 0;                                // rangeMax.y (top of screen)

      // ---- Indices 8-9: Scale Types ----
      scaleParams[8] = this.#getGPUScaleType(scaleTypes.x);  // scaleTypes.x
      scaleParams[9] = this.#getGPUScaleType(scaleTypes.y);  // scaleTypes.y

      // ---- Indices 10-11: Bandwidth (for band scales) ----
      scaleParams[10] = c.xBandwidth ?? 0;
      scaleParams[11] = c.yBandwidth ?? 0;

      // ---- Indices 12-13: Category Count (for band scales) ----
      scaleParams[12] = xGpuState.categoryCount ?? 0;        // categoryCount.x
      scaleParams[13] = yGpuState.categoryCount ?? 0;        // categoryCount.y

      // ---- Indices 14-15: Pre-computed Domain Scale Factors ----
      scaleParams[14] = xGpuState.domainScale ?? (1.0 / (xGpuState.domainMax - xGpuState.domainMin)); // domainScale.x
      scaleParams[15] = yGpuState.domainScale ?? (1.0 / (yGpuState.domainMax - yGpuState.domainMin)); // domainScale.y

      // ---- Indices 16-17: Pre-computed Range Sizes ----
      scaleParams[16] = c.innerWidth;                         // rangeSize.x
      scaleParams[17] = -c.innerHeight;                       // rangeSize.y (negative for screen coords)

      // ---- Zero out padding slots (18-31) ----
      scaleParams.fill(0, 18);

      // Write to GPU buffer
      this.#device.queue.writeBuffer(this.#scaleParamsBuffer, 0, scaleParams);

      // console.log('🔍 GPU Scale Parameters:', {
      //   // Core domain/range (what GPU actually uses)
      //   xDomain: [scaleParams[0], scaleParams[2]],        // [domainMin.x, domainMax.x]
      //   yDomain: [scaleParams[1], scaleParams[3]],        // [domainMin.y, domainMax.y]
      //   xRange: [scaleParams[4], scaleParams[6]],         // [rangeMin.x, rangeMax.x]
      //   yRange: [scaleParams[5], scaleParams[7]],         // [rangeMin.y, rangeMax.y]
        
      //   // Scale configuration
      //   xScaleType: scaleParams[8],                       // Should be 0 for linear
      //   yScaleType: scaleParams[9],                       // Should be 1 for band
      //   yBandwidth: scaleParams[11],                      // bandwidth.y
        
      //   // Your data for comparison
      //   dataX0: 32.1, // Sample from your data
      //   dataX1: 46,   // Sample from your data
      //   dataY: 0,     // Sample from your data (category index)
        
      //   // Quick manual calculation
      //   expectedScreenX0: (32.1 - scaleParams[0]) / (scaleParams[2] - scaleParams[0]) * scaleParams[6],
      //   expectedScreenX1: (46 - scaleParams[0]) / (scaleParams[2] - scaleParams[0]) * scaleParams[6]
      // });
      // console.log('🔍 Scale Parameters sent to GPU (FINAL):', {
      //   // Core domain/range
      //   xDomain: [scaleParams[0], scaleParams[2]],        // [domainMin.x, domainMax.x]
      //   yDomain: [scaleParams[1], scaleParams[3]],        // [domainMin.y, domainMax.y]
      //   xRange: [scaleParams[4], scaleParams[6]],         // [rangeMin.x, rangeMax.x]
      //   yRange: [scaleParams[5], scaleParams[7]],         // [rangeMin.y, rangeMax.y]
        
      //   // Scale configuration
      //   xScaleType: scaleParams[8],                       // scaleTypes.x
      //   yScaleType: scaleParams[9],                       // scaleTypes.y
      //   xBandwidth: scaleParams[10],                      // bandwidth.x
      //   yBandwidth: scaleParams[11],                      // bandwidth.y
        
      //   // Pre-computed optimization factors
      //   xDomainScale: scaleParams[14],                    // domainScale.x (1/domainWidth)
      //   yDomainScale: scaleParams[15],                    // domainScale.y (1/domainHeight)
      //   xRangeSize: scaleParams[16],                      // rangeSize.x (rangeWidth)
      //   yRangeSize: scaleParams[17],                      // rangeSize.y (rangeHeight)
        
      //   // Chart dimensions for reference
      //   innerWidth: c.innerWidth,
      //   innerHeight: c.innerHeight
      // });
        
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

  // ===== REACTIVE EFFECTS HELPERS =====

  /**
   * Updates the GPU buffer that contains scale parameters (domain, range, etc.).
   * This should be called whenever the scale's domain or range changes.
   * 
   * ✅ UPDATED: Now triggers per-frame bind group recreation if scale parameters change
   * 
   * @param {Function} callback - Optional callback after parameters are updated.
   */
  handleScaleOrRangeUpdate(callback) {
    if (this.#resourcesCreated && !this.#initializationError) {
      this.updateScaleParameters(); // This updates the GPU buffer
      // Note: No need to recreate bind group - we're just updating buffer contents
      if (callback) callback();
    }
  }

  /**
   * Helper method to update resolution (called from component's $effect)  
   * @param {Function} callback - Optional callback when resolution changes
   */
  handleResolutionChange(callback) {
    if (this.#resourcesCreated && !this.#initializationError) {
      this.updateResolution();
      // Note: No need to recreate bind group - we're just updating buffer contents
      if (callback) callback();
    }
  }

  // ===== LAYER MANAGEMENT =====

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

      console.log(`📋 ${this.#markType} layer registered directly with coordinator for chart ${chartId}`);
      return this.#ownedResources.layerControl;

    } catch (error) {
      console.error(`❌ ${this.#markType} layer registration failed:`, error);
      this.#initializationError = error.message;
      throw error;
    }
  }

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