// src/lib/gpu/GPUCoordinator.svelte.js - Complete Scale Instance Buffer Pool Architecture

import { setContext, getContext } from 'svelte';
import { scaleTemplateSystem } from './ScaleTemplateSystem.js';

const TIMESTEP = 1000 / 240; // 60Hz physics clock


// Add this class inside GPUCoordinator.svelte.js before the GPUCoordinator class
class ScaleIndexManager {
  #scaleIds = [];
  #scaleIdToIndex = new Map();

  rebuild(allCurrentScaleIds) {
    console.log('Rebuilding scale indices:', allCurrentScaleIds);
    this.#scaleIds = [...allCurrentScaleIds];
    this.#scaleIdToIndex.clear();
    
    this.#scaleIds.forEach((scaleId, index) => {
      this.#scaleIdToIndex.set(scaleId, index);
    });
    
    console.log('Scale index mapping:', Object.fromEntries(this.#scaleIdToIndex));
    return this.#scaleIds.length;
  }

  getIndex(scaleId) {
    return this.#scaleIdToIndex.get(scaleId);
  }

  getCount() {
    return this.#scaleIds.length;
  }

  getAllScaleIds() {
    return [...this.#scaleIds];
  }
}


/**
 * Enhanced GPUCoordinator with scale instance buffer pools
 * Eliminates CPU-GPU sync stalls during panning/zooming
 */
export class GPUCoordinator {
  // Core WebGPU resources
  #device = $state(null);
  #presentationFormat = $state(null);
  #initialized = $state(false);

  // Enhanced shared resources with reference counting
  #sharedResources = $state({
    pipelines: new Map(),           // markType -> { pipeline, refCount, createdAt }
    uniformBuffers: new Map(),      // name -> { buffer, refCount, createdAt }
    shaderModules: new Map(),       // markType -> { module, refCount, createdAt }
    bindGroupLayouts: new Map()     // markType -> { layout, refCount, createdAt }
  });

  // Chart registration and management
  #registeredCharts = $state(new Map());
  #msaaCache = new Map();
  #dirtyChartIDs = new Set();
  #renderScheduled = false;

  // Animation system properties
  #animatedScales = new Set();
  #animationActive = false;
  #animationRafId = null;
  #scaleRegistry = null;
  #accumulator = 0;
  #lastFrameTime = 0;
  #chartsToRenderSet = new Set();
  #chartsToRenderArray = [];
  #msaaSampleCount = 4;
  #globalInputDelay = 0;
  #renderCount = 0;

  // Performance tracking
  #smoothedDeltaTime = 8.3; // Initialize to ideal 60fps
  #smoothingFactor = 0.05; // Adjust this value (0.05 to 0.2 is a good range)
  #frameHistory = [];
  #frameTimings = [];

  // Race condition protection
  #creatingPipelines = new Set();

  // Scale instance buffer pool system
  #BUFFER_POOL_SIZE = 3; // Configurable buffer pool size
  #scaleInstancePools = new Map(); // scaleId -> { buffers: [buf0, buf1, buf2], bindGroups: [bg0, bg1, bg2], activeIndex: 0, scaleType, size }
  #scaleBindGroupLayouts = new Map(); // scaleType -> GPUBindGroupLayout
  // #bufferCycle = {
  //   current: 0,    // Which buffer index is active for GPU reads
  //   next: 1,       // Which buffer index to write to  
  //   previous: 2    // Which buffer index was active last frame
  // };
  #bufferCycle = {
    currentIndex: 0  // The only index we need to track
  };

  #templateSystem = scaleTemplateSystem;
  #frameLayout = null;
  #dataLayouts = new Map(); // markType-config -> GPUBindGroupLayout
  #pendingPoolCreations = []; // Optional: for lazy creation pattern
  #pendingScaleMappings = new Map(); // chartId -> { xScaleId, yScaleId }
  #pendingFrameUpdates = new Map(); // chartId -> update params

  #frameCompletionPromises = [];
  // #frameCompletionPromises = new Map();
  #lastFenceTime
  #lastFrameUsingBuffer = new Array(this.#BUFFER_POOL_SIZE).fill(0); // Track which frame last used each buffer
  #nextFrameId = 0;

  #scaleIndexManager = null;
  #globalScaleBuffers = [];
  #globalStagingBuffers = [];  
  #globalScaleBindGroup = null;
  #maxScaleSlots = 256;

  #SSBO_SLOT_COUNT = 3;
  #MAX_FRAMES_IN_FLIGHT = 2;  
  #frameId = 0;
  #inflightPromises = [];
  #stagingPool = [];
  #globalScaleSSBO = null;  // Single buffer with 3 slots
  #slotByteSize = null;
  #globalScaleBindGroups = [];

  constructor(config = {}) {
    this.#msaaSampleCount = config.msaaSampleCount ?? 4;

    this.#scaleIndexManager = new ScaleIndexManager();


    this.perf = new MinimalPerfLogger(10000);
    if (typeof window !== 'undefined') {
      window.exportPerf = () => this.perf.downloadJSON();
      window.resetPerf = () => this.perf.reset();
      window.perfStatus = () => console.log(`${this.perf.index}/${this.perf.maxSamples} samples collected`);
    }
  }

  async initialize() {
    if (this.#initialized) return;
    try {
      await this.#initWebGPU();
      await this.#createSharedResources();
      await this.#initializeScaleBindGroupLayouts();
      this.#initialized = true;
      // Process any queued pool creations
      for (const pending of this.#pendingPoolCreations) {
        this.#doCreateBufferPoolForScale(pending.scaleId, pending.scaleType);
      }
      this.#pendingPoolCreations = [];
      console.log('GPUCoordinator initialized with scale instance buffer pool architecture');
    } catch (error) {
      console.error('GPUCoordinator initialization failed:', error);
      throw error;
    }
  }

  // ===== NEW: SCALE INSTANCE BUFFER POOL MANAGEMENT =====

  /**
   * Initialize bind group layouts for different scale types
   * @private
   */
  // async #initializeScaleBindGroupLayouts() {
  //   // Linear scale bind group layout
  //   const linearLayout = this.#device.createBindGroupLayout({
  //     label: 'linear-scale-bind-group-layout',
  //     entries: [{
  //       binding: 0,
  //       visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
  //       buffer: { type: 'uniform' }
  //     }]
  //   });
    
  //   this.#scaleBindGroupLayouts.set('linear', linearLayout);
    
  //   // Future scale types can be added here
  //   // this.#scaleBindGroupLayouts.set('band', bandLayout);
  //   // this.#scaleBindGroupLayouts.set('log', logLayout);
    
  //   console.log('Initialized scale bind group layouts:', Array.from(this.#scaleBindGroupLayouts.keys()));
  // }

  async #initializeScaleBindGroupLayouts() {
    // Create global SSBO layout (one layout for all scale types)
    const globalScaleLayout = this.#device.createBindGroupLayout({
      label: 'global-scale-ssbo-layout',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { 
          type: 'read-only-storage' // Changed from 'uniform' to 'read-only-storage'
        }
      }]
    });
    
    // Store as 'global' instead of individual scale types
    this.#scaleBindGroupLayouts.set('global', globalScaleLayout);
    
    // Create the actual SSBO buffers
    // this.#createGlobalScaleBuffers();
    this.#createGlobalScaleSSBO();

    for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
      const layout = this.#scaleBindGroupLayouts.get('global');
      const slotOffset = slot * this.#slotByteSize;
      const bg = this.#device.createBindGroup({
        label: `global-scale-bind-group-slot-${slot}`,
        layout,
        entries: [{ binding: 0, resource: { buffer: this.#globalScaleSSBO, offset: slotOffset, size: this.#slotByteSize } }]
      });
      this.#globalScaleBindGroups[slot] = bg;
    }
    // this.#createGlobalScaleBindGroup();
    
    console.log('Initialized global SSBO layout, buffers, and bind group');

  }

  /**
   * Get or create the shared frame layout for all charts
   * @private
   */
  #getOrCreateFrameLayout() {
    if (!this.#frameLayout) {
      this.#frameLayout = this.#device.createBindGroupLayout({
        label: 'shared-frame-layout',
        entries: [{
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' }
        }]
      });
      console.log('Created shared frame layout for per-chart uniforms');
    }
    return this.#frameLayout;
  }

  #createGlobalScaleSSBO() {
    const scaleParamSize = 16; // 4 floats * 4 bytes 
    this.#slotByteSize = this.#maxScaleSlots * scaleParamSize;
    const totalSSBOSize = this.#slotByteSize * this.#SSBO_SLOT_COUNT;
    
    // Single SSBO with 3 slots
    this.#globalScaleSSBO = this.#device.createBuffer({
      size: totalSSBOSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'global-scale-ssbo-triple-buffered'
    });
    
    // Create staging buffer pool (pre-mapped)
    for (let i = 0; i < 4; i++) { // 4 staging buffers for safety
      const staging = this.#device.createBuffer({
        size: this.#slotByteSize,
        usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
        label: `scale-staging-pool-${i}`
      });
      this.#stagingPool.push(staging);
    }
  }

  // // Add this method to GPUCoordinator
  // #createGlobalScaleBuffers() {
  //   console.log('Creating global scale SSBO system');
    
  //   // Clean up existing buffers if they exist
  //   this.#globalScaleBuffers.forEach(buffer => buffer?.destroy?.());
  //   this.#globalStagingBuffers.forEach(staged => staged.buffer?.destroy?.());
    
  //   const scaleParamSize = 16; // 4 floats * 4 bytes
  //   const totalBufferSize = this.#maxScaleSlots * scaleParamSize;
    
  //   for (let i = 0; i < this.#BUFFER_POOL_SIZE; i++) {
  //     // Create SSBO
  //     const storageBuffer = this.#device.createBuffer({
  //       size: totalBufferSize,
  //       usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  //       label: `global-scale-ssbo-${i}`
  //     });
      
  //     // Create staging buffer (mapped for CPU access)
  //     const stagingBuffer = this.#device.createBuffer({
  //       size: totalBufferSize,
  //       usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
  //       mappedAtCreation: true,
  //       label: `scale-staging-${i}`
  //     });
      
  //     this.#globalScaleBuffers.push(storageBuffer);

  //     const mappedRange = stagingBuffer.getMappedRange();
  //     const view = new Float32Array(mappedRange);
      
  //     // IMPORTANT: Unmap the buffer before storing it
  //     stagingBuffer.unmap();
      
  //     this.#globalStagingBuffers.push({
  //       buffer: stagingBuffer,
  //       view: null  // Will be remapped when needed
  //     });
  //     // this.#globalStagingBuffers.push({
  //     //   buffer: stagingBuffer,
  //     //   view: new Float32Array(stagingBuffer.getMappedRange())
  //     // });
  //   }
    
  //   console.log(`Created ${this.#BUFFER_POOL_SIZE} global scale buffers, ${totalBufferSize} bytes each`);
  // }

  // // Add this method to GPUCoordinator
  // async #updateScaleSSBO() {
  //   if (this.#animatedScales.size === 0) return;
    
  //   const currentIndex = this.#bufferCycle.currentIndex;
  //   const stagingBuffer = this.#globalStagingBuffers[currentIndex];
    
  //   if (!stagingBuffer) {
  //     console.warn('No staging buffer available for current index:', currentIndex);
  //     return;
  //   }

  //   await stagingBuffer.buffer.mapAsync(GPUMapMode.WRITE);
  //   const mappedRange = stagingBuffer.buffer.getMappedRange();
  //   const view = new Float32Array(mappedRange);
  
    
  //   // Fill staging buffer with current scale data
  //   for (const scale of this.#animatedScales) {
  //     const globalIndex = this.#scaleIndexManager.getIndex(scale.id);
      
  //     if (globalIndex !== undefined) {
  //       const gpuState = scale.gpuState;
  //       if (gpuState) {
  //         const offset = globalIndex * 4; // 4 floats per scale
          
  //         stagingBuffer.view[offset + 0] = gpuState.domainMin;
  //         stagingBuffer.view[offset + 1] = gpuState.domainMax;
  //         stagingBuffer.view[offset + 2] = gpuState.domainScale || (1.0 / (gpuState.domainMax - gpuState.domainMin));
  //         stagingBuffer.view[offset + 3] = 0; // padding
  //       }
  //     }
  //   }
    
  //   stagingBuffer.buffer.unmap();

  //   // Single GPU copy operation
  //   const commandEncoder = this.#device.createCommandEncoder();
  //   commandEncoder.copyBufferToBuffer(
  //     stagingBuffer.buffer, 0,
  //     this.#globalScaleBuffers[currentIndex], 0,
  //     this.#scaleIndexManager.getCount() * 16
  //   );
  //   this.#device.queue.submit([commandEncoder.finish()]);
  // }

  // Replace #updateScaleSSBO with synchronous staging pool access
  async #updateScaleSSBOWithStaging() {
    if (this.#animatedScales.size === 0) return;
    
    // Wait for in-flight limit
    while (this.#inflightPromises.length >= this.#MAX_FRAMES_IN_FLIGHT) {
      await this.#inflightPromises[0];
      this.#inflightPromises.shift();
    }
    
    // Get pre-mapped staging buffer from pool
    const staging = this.#stagingPool.pop();
    if (!staging) {
      console.warn('No staging buffer available in pool');
      return;
    }
    
    // Calculate destination slot  
    const slot = this.#frameId % this.#SSBO_SLOT_COUNT;
    const dstOffset = slot * this.#slotByteSize;
    
    // Write all scales synchronously to mapped staging
    const view = new Float32Array(staging.getMappedRange());
    this.#fillAllScales(view);
    
    return { staging, dstOffset, slot };
  }

  #fillAllScales(view) {
    for (const scale of this.#animatedScales) {
      const globalIndex = this.#scaleIndexManager.getIndex(scale.id);
      if (globalIndex !== undefined) {
        const gpuState = scale.gpuState;
        if (gpuState) {
          const offset = globalIndex * 4; // 4 floats per scale
          view[offset + 0] = gpuState.domainMin;
          view[offset + 1] = gpuState.domainMax; 
          view[offset + 2] = gpuState.domainScale || (1.0 / (gpuState.domainMax - gpuState.domainMin));
          view[offset + 3] = 0; // padding
        }
      }
    }
  }


  // #createGlobalScaleBindGroup(slot) {
  //   const layout = this.#scaleBindGroupLayouts.get('global');
  //   if (!layout) {
  //     console.error('Global scale layout not found');
  //     return null;
  //   }

  //   const slotOffset = slot * this.#slotByteSize;
    
  //   return this.#device.createBindGroup({
  //     label: `global-scale-bind-group-slot-${slot}`,
  //     layout: layout,
  //     entries: [{
  //       binding: 0,
  //       resource: { 
  //         buffer: this.#globalScaleSSBO,
  //         offset: slotOffset,
  //         size: this.#slotByteSize 
  //       }
  //     }]
  //   });
  // }



  /**
   * Create buffer pool for a specific scale instance
   * Called by LinearScaleState constructor
   */

  // createBufferPoolForScale(scaleId, scaleType = 'linear') {
  //   if (!this.#initialized) {
  //     this.#pendingPoolCreations.push({ scaleId, scaleType });
  //     console.debug(`Queued buffer pool creation for scale ${scaleId} - coordinator not yet initialized`);
  //     return;
  //   }
  //   this.#doCreateBufferPoolForScale(scaleId, scaleType);
  // }

  createBufferPoolForScale(scaleId, scaleType = 'linear') {
    if (!this.#initialized) {
      this.#pendingPoolCreations.push({ scaleId, scaleType });
      return;
    }
    
    console.log(`Registering scale ${scaleId} for global SSBO`);
    
    // Keep a placeholder entry in the old map for compatibility during transition
    this.#scaleInstancePools.set(scaleId, { type: scaleType, globalIndex: null });
    
    // Trigger topology rebuild to assign global index
    this.#handleScaleTopologyChange();
  }

  destroyBufferPoolForScale(scaleId) {
    console.log(`Unregistering scale ${scaleId} from global SSBO`);
    
    // Remove from old map
    this.#scaleInstancePools.delete(scaleId);
    
    // Trigger topology rebuild
    this.#handleScaleTopologyChange();
  }

  #handleScaleTopologyChange() {
    // TODO

    // // Use existing scale instance pools to get all registered scales
    // const allScaleIds = Array.from(this.#scaleInstancePools.keys());
    
    // // Add any pending scales that haven't been processed yet
    // this.#pendingPoolCreations.forEach(p => {
    //   if (!allScaleIds.includes(p.scaleId)) {
    //     allScaleIds.push(p.scaleId);
    //   }
    // });
    
    // const scaleCount = this.#scaleIndexManager.rebuild(allScaleIds);
    
    // if (scaleCount > 0 && this.#globalScaleBuffers.length > 0) {
    //   // Recreate bind group to point to current buffer
    //   // TODO: fix
    //   // this.#createGlobalScaleBindGroup();
    // }
    
    // console.log(`Scale topology changed: ${scaleCount} scales registered`);
  }

  #doCreateBufferPoolForScale(scaleId, scaleType) {
    // Move existing createBufferPoolForScale implementation here
    if (this.#scaleInstancePools.has(scaleId)) {
      console.debug(`Buffer pool already exists for scale instance ${scaleId}`);
      return;
    }

    try {
      // Get bind group layout for this scale type
      let bindGroupLayout = this.#scaleBindGroupLayouts.get(scaleType);
      if (!bindGroupLayout) {
        console.error(`No bind group layout found for scale type: ${scaleType}`);
        return;
      }

      const bufferSize = this.#getBufferSizeForScaleType(scaleType);

      // Create uniform buffers for this scale instance
      const buffers = [];
      for (let i = 0; i < this.#BUFFER_POOL_SIZE; i++) {
        const buffer = this.#device.createBuffer({
          size: bufferSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: `${scaleType}-scale-instance-${scaleId}-buffer-${i}`
        });
        buffers.push(buffer);
      }

      // Pre-create bind groups (one for each buffer)
      const bindGroups = [];
      for (let i = 0; i < this.#BUFFER_POOL_SIZE; i++) {
        const bindGroup = this.#device.createBindGroup({
          label: `${scaleType}-scale-instance-${scaleId}-bind-group-${i}`,
          layout: bindGroupLayout,
          entries: [{
            binding: 0,
            resource: { buffer: buffers[i] }
          }]
        });
        bindGroups.push(bindGroup);
      }

      // Initialize all buffers with default data
      const defaultData = this.#getDefaultDataForScaleType(scaleType);
      for (let i = 0; i < this.#BUFFER_POOL_SIZE; i++) {
        this.#device.queue.writeBuffer(buffers[i], 0, defaultData);
      }

      // Store pool for this scale instance
      this.#scaleInstancePools.set(scaleId, {
        buffers,
        bindGroups,
        activeIndex: 0,
        scaleType,
        size: bufferSize
      });

      console.log(`Created buffer pool for scale instance ${scaleId} (${scaleType}): 3 x ${bufferSize} bytes`);

    } catch (error) {
      console.error(`Failed to create buffer pool for scale ${scaleId}:`, error);
    }
  }


  /**
   * Destroy buffer pool for a specific scale instance
   * Called by LinearScaleState destructor
   */
  // destroyBufferPoolForScale(scaleId) {
  //   const instancePool = this.#scaleInstancePools.get(scaleId);
  //   if (!instancePool) {
  //     console.debug(`No buffer pool found for scale instance ${scaleId} - already destroyed or never created`);
  //     return;
  //   }

  //   try {
  //     // Destroy all buffers
  //     instancePool.buffers.forEach((buffer, index) => {
  //       if (!buffer.destroyed) {
  //         buffer.destroy();
  //       }
  //     });

  //     // Remove from tracking
  //     this.#scaleInstancePools.delete(scaleId);

  //     console.log(`Destroyed buffer pool for scale instance ${scaleId}`);

  //   } catch (error) {
  //     console.error(`Failed to destroy buffer pool for scale ${scaleId}:`, error);
  //   }
  // }

  /**
   * Get buffer size for a scale type
   * @private
   */
  #getBufferSizeForScaleType(scaleType) {
    switch (scaleType) {
      case 'linear':
        return 16; // 3 x f32 values (12 bytes: domainMin, domainMax, domainScale +  4 bytes padding)
      case 'band':
        return 48; // Future: more fields for band scales
      case 'log':
        return 32; // Future: logarithmic scale parameters
      default:
        console.warn(`Unknown scale type: ${scaleType}, defaulting to linear size`);
        return 32;
    }
  }

  /**
   * Get default data for a scale type
   * @private
   */
  #getDefaultDataForScaleType(scaleType) {
    switch (scaleType) {
      case 'linear':
        return new Float32Array([0, 1, 1, 0]); // domain[0,1], scale=1, padding
        // return new Float32Array([0, 1, 0, 1, 1, 0, 0, 0]); // domain[0,1], range[0,1], scale=1, padding
      case 'band':
        return new Float32Array(12); // Future: band scale defaults
      case 'log':
        return new Float32Array([1, 10, 0, 1, 0.434, 0, 0, 0]); // Future: log scale defaults
      default:
        return new Float32Array(8);
    }
  }

  /**
   * Get current active bind group for a specific scale instance
   * Called during render loop
   */
  getCurrentScaleBindGroup(scaleId) {
    const instancePool = this.#scaleInstancePools.get(scaleId);
    if (!instancePool) {
      console.error(`No buffer pool found for scale instance: ${scaleId}`);
      return null;
    }
    
    return instancePool.bindGroups[instancePool.activeIndex];
  }

  /**
   * Get scale bind group layout for renderer pipeline creation
   * Called by BaseGPURenderer during initialization
   */
  getScaleBindGroupLayout(scaleType = 'linear') {
    const layout = this.#scaleBindGroupLayouts.get(scaleType);
    if (!layout) {
      console.error(`No bind group layout found for scale type: ${scaleType}`);
      return null;
    }
    return layout;
  }

  /**
   * Write scale data to the "next" buffer slot for a specific scale instance
   * Called by animation loop when scale data changes
   */
  writeScaleDataForInstance(scaleId, data) {
    const instancePool = this.#scaleInstancePools.get(scaleId);
    if (!instancePool) {
      console.error(`No buffer pool found for scale instance: ${scaleId}`);
      return;
    }

    try {
      // Write to the "next" buffer using WebGPU's async writeBuffer
      // const nextBufferIndex = this.#bufferCycle.next;      
      const nextBufferIndex = (this.#bufferCycle.currentIndex + 1) % this.#BUFFER_POOL_SIZE;
      
      // // --- SAFETY CHECK ---
      // // Check if the frame that last used this buffer is still running on GPU
      // const lastFrameIdThatUsedThisBuffer = this.#lastFrameUsingBuffer[nextBufferIndex];
      
      // if (this.#frameCompletionPromises.has(lastFrameIdThatUsedThisBuffer)) {
      //   console.error(`BUFFER HAZARD DETECTED: Attempting to write to buffer index ${nextBufferIndex}, ` +
      //     `which was last used by frame ${lastFrameIdThatUsedThisBuffer}, ` +
      //     `but that frame's GPU work has not yet completed. ` +
      //     `This indicates the buffer pool is too small or the GPU is stalled.`);
        
      //   // In production, you might want to:
      //   // - Skip this write operation
      //   // - Increase buffer pool size
      //   // - Apply additional backpressure
      //   return; // Skip the write to prevent corruption
      // }

      const targetBuffer = instancePool.buffers[nextBufferIndex];
      this.#device.queue.writeBuffer(targetBuffer, 0, data);
            
    } catch (error) {
      console.error(`Failed to write scale data for instance ${scaleId}:`, error);
    }
  }

  /**
   * Cycle buffer pools for specific scale instances
   * Only cycles pools for scales that have new data
   * @private
   */
  #cycleScaleBuffersForInstances(dirtyScaleIds) {
    if (dirtyScaleIds.size === 0) return;

    // Update buffer cycle indices (global)
    // const temp = this.#bufferCycle.previous;
    // this.#bufferCycle.previous = this.#bufferCycle.current;
    // this.#bufferCycle.current = this.#bufferCycle.next;
    // this.#bufferCycle.next = temp;

    // Advance to next buffer using modulo arithmetic
    const newCurrentIndex = (this.#bufferCycle.currentIndex + 1) % this.#BUFFER_POOL_SIZE;
    this.#bufferCycle.currentIndex = newCurrentIndex;


    // Update active index only for dirty scale instances
    for (const scaleId of dirtyScaleIds) {
      const instancePool = this.#scaleInstancePools.get(scaleId);
      if (instancePool) {
        // instancePool.activeIndex = this.#bufferCycle.current;
        instancePool.activeIndex = newCurrentIndex;
      }
    }
  }

  /**
   * Create frame uniform buffer and bind group for a specific chart
   * @private
   */
  #createChartFrameResources(chartId) {
    const chartConfig = this.#registeredCharts.get(chartId);
    if (!chartConfig || chartConfig.frameUniformsBuffer) {
      return; // Chart doesn't exist or resources already created
    }

    try {
      chartConfig.frameUniformsBuffer = this.#device.createBuffer({
        size: 48, // 10 x f32 = 40 bytes 
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `frame-uniforms-${chartId}`
      });

      // Create the bind group
      this.#createChartFrameBindGroup(chartId);
      
      console.log(`Created frame resources for chart ${chartId}`);
      
    } catch (error) {
      console.error(`Failed to create frame resources for chart ${chartId}:`, error);
    }
  }

  /**
   * Create frame bind group for a specific chart
   * @private
   */
  #createChartFrameBindGroup(chartId) {
    const chartConfig = this.#registeredCharts.get(chartId);
    if (!chartConfig?.frameUniformsBuffer || chartConfig.perFrameBindGroup) {
      return; // Buffer not ready or bind group already exists
    }

    try {
      const frameLayout = this.#getOrCreateFrameLayout();
      
      chartConfig.perFrameBindGroup = this.#device.createBindGroup({
        label: `per-frame-bind-group-${chartId}`,
        layout: frameLayout,
        entries: [{
          binding: 0,
          resource: { buffer: chartConfig.frameUniformsBuffer }
        }]
      });
      
      console.log(`Created frame bind group for chart ${chartId}`);
      
    } catch (error) {
      console.error(`Failed to create frame bind group for chart ${chartId}:`, error);
    }
  }

  /**
   * Update frame uniforms for a specific chart
   * Called when canvas dimensions or DPR changes
   */
  updateChartFrameUniforms(chartId) {
    const chartConfig = this.#registeredCharts.get(chartId);
    if (!chartConfig?.contextConfigured) {
      console.debug(`Queueing frame uniforms update for unregistered chart ${chartId}`);
      this.#pendingFrameUpdates.set(chartId, { timestamp: Date.now() });
      return;
    }

    try {
      // Create resources if they don't exist yet
      if (!chartConfig.frameUniformsBuffer) {
        this.#createChartFrameResources(chartId);
      }

      const dpr = window.devicePixelRatio || 1;
      const canvas = chartConfig.canvas;

      // Compute in logical CSS px, then convert ranges to physical px
      const resX = canvas.width; 
      const resY = canvas.height;
      
      const rangeMinX = 0 * dpr;
      const rangeMinY = canvas.clientHeight * dpr;
      const rangeMaxX = canvas.clientWidth * dpr;
      const rangeMaxY = 0 * dpr;

      const xScaleIndex = this.#scaleIndexManager.getIndex(chartConfig.xScaleId) ?? 0;
      const yScaleIndex = this.#scaleIndexManager.getIndex(chartConfig.yScaleId) ?? 1;
      
      // Build 48-byte uniform payload
      const buf = new ArrayBuffer(48);
      const f32 = new Float32Array(buf);
      const u32 = new Uint32Array(buf);

      // Floats: resolution(2), rangeMin(2), rangeMax(2), devicePixelRation, _pad0
      f32[0] = resX;
      f32[1] = resY;
      f32[2] = rangeMinX;
      f32[3] = rangeMinY;
      f32[4] = rangeMaxX;
      f32[5] = rangeMaxY;
      f32[6] = dpr;
      f32[7] = 0.0;

      // U32s: xScaleIndex, yScaleIndex, _pad1 (2x)
      u32[8] = xScaleIndex >>> 0;
      u32[9] = yScaleIndex >>> 0;
      u32[10] = 0;
      u32[11] = 0;
      
      this.#device.queue.writeBuffer(chartConfig.frameUniformsBuffer, 0, buf);
      
    } catch (error) {
      console.error(`Failed to update frame uniforms for chart ${chartId}:`, error);
    }
  }

  // Process pending updates when chart becomes ready
  #processPendingFrameUpdates(chartId) {
    const pendingUpdate = this.#pendingFrameUpdates.get(chartId);
    if (pendingUpdate) {
      console.debug(`Processing queued frame uniforms update for chart ${chartId}`);
      this.updateChartFrameUniforms(chartId);
      this.#pendingFrameUpdates.delete(chartId);
    }
  }

  // Add this method to GPUCoordinator
  #cycleScaleBuffers() {
    // Advance to next buffer slot
    this.#bufferCycle.currentIndex = (this.#bufferCycle.currentIndex + 1) % this.#BUFFER_POOL_SIZE;
    
    // Update the global bind group to point to the new current buffer
    if (this.#globalScaleBindGroup) {
      const layout = this.#scaleBindGroupLayouts.get('global');
      
      this.#globalScaleBindGroup = this.#device.createBindGroup({
        label: 'global-scale-bind-group',
        layout: layout,
        entries: [{
          binding: 0,
          resource: { buffer: this.#globalScaleBuffers[this.#bufferCycle.currentIndex] }
        }]
      });
    }
    
    console.debug(`Cycled to scale buffer index ${this.#bufferCycle.currentIndex}`);
  }

  // ===== UPDATED: ANIMATION LOOP WITH SCALE INSTANCE INTEGRATION =====

  #animationLoop = async (currentTime) => {
    const loopStart = performance.now();
    
    // Enhanced timing logic with smoothing
    const now = performance.now();
    if (this.#lastFrameTime === 0) this.#lastFrameTime = now;
    let deltaTime = now - this.#lastFrameTime;
    this.#lastFrameTime = now;

    if (deltaTime < 0) deltaTime = 8.3;
    if (deltaTime > 250) deltaTime = 250; // Clamp to prevent spiral-of-death on tab resume

    // const MAX_FRAMES_IN_FLIGHT = 2;
    // if (this.#frameCompletionPromises.length >= MAX_FRAMES_IN_FLIGHT) {
    //   // console.log('in flight frame limit reached, awaiting oldest')
    //   await this.#frameCompletionPromises[0]; // Dequeue and await the oldest promise
    //   this.#frameCompletionPromises.shift(); // Dequeue and await the oldest promise
    // }
    // await new Promise(resolve => setTimeout(resolve, 0)); 

    // Smooth delta time for better performance metrics
    this.#smoothedDeltaTime = this.#smoothingFactor * deltaTime + (1 - this.#smoothingFactor) * this.#smoothedDeltaTime;
    this.#accumulator += deltaTime;

    // Fixed-step physics loop
    while (this.#accumulator >= TIMESTEP) {
      // Process input
      for (const scale of this.#animatedScales) {
        const scheduledProcessed = scale._processScheduledInput?.(now, this.#globalInputDelay);
        if (!scheduledProcessed && scale._applyInput) {
          scale._applyInput(now);
        }
      }

      // Update physics
      for (const scale of this.#animatedScales) {
        if (scale._updatePhysics) {
          scale._updatePhysics(TIMESTEP);
        }
      }
      this.#accumulator -= TIMESTEP;
    }

    // Prepare for render with interpolation
    const alpha = this.#accumulator / TIMESTEP;
    const chartsToRender = this.#chartsToRenderSet;
    chartsToRender.clear();
    
    let renderCurrent;
    // const dirtyScaleIds = new Set(); // Track which scale instances have new data

    // if (this.#frameCompletionPromises.length >= 2) {
    //   console.warn('Buffer update - queue full');
    //   // await this.#frameCompletionPromises.shift();
    //   // return; // Or use last values
    // } else {
    //   console.warn('Buffer update - queue ok!');
    // }

    // // NEW: Coordinator writes scale data directly to scale instance pools
    // for (const scale of this.#animatedScales) {
    //   renderCurrent = scale._setRenderState(alpha);
      
    //   // COORDINATOR reads gpuState directly and writes to scale instance buffer pool
    //   const gpuState = scale.gpuState;
    //   if (gpuState) {
    //     // Create scale data based on scale type
    //     const scaleData = this.#createScaleDataFromGpuState(gpuState, scale.type || 'linear');
        
    //     // Write to "next" buffer in pool for this specific scale instance
    //     this.writeScaleDataForInstance(scale.id, scaleData);
    //     dirtyScaleIds.add(scale.id); // Mark this scale instance as dirty
    //   }

    //   // Add affected charts to render list
    //   const affectedCharts = this.#getChartsUsingScale(scale);
    //   affectedCharts.forEach(chartId => chartsToRender.add(chartId));
    // }

    for (const scale of this.#animatedScales) {
      renderCurrent = scale._setRenderState(alpha);
      
      // Add affected charts to render list
      const affectedCharts = this.#getChartsUsingScale(scale);
      affectedCharts.forEach(chartId => chartsToRender.add(chartId));
    }

    // Single batched SSBO update replaces individual writeScaleDataForInstance calls
    // if (this.#animatedScales.size > 0) {
    //   // this.#updateScaleSSBO();
    //   this.#updateScaleSSBOWithStaging();
    //   this.#cycleScaleBuffers(); 
    // }

    // Add any charts that were dirtied by non-animation events
    this.#dirtyChartIDs.forEach(id => chartsToRender.add(id));
    this.#dirtyChartIDs.clear();

    // Cycle buffers only for dirty scale instances
    // if (dirtyScaleIds.size > 0) {
      // this.#cycleScaleBuffersForInstances(dirtyScaleIds);
    // }

    this.#nextFrameId++;

    // // Check backpressure - if too many frames in flight, skip rendering
    // const MAX_FRAMES_IN_FLIGHT = 2;
    // if (this.#frameCompletionPromises.size >= MAX_FRAMES_IN_FLIGHT) {
    //   console.debug(`Skipping render (backpressure: ${this.#frameCompletionPromises.size} frames in flight)`);
    //   // Physics and buffer updates still occurred, just skip GPU submission
    //   // this.perf.log(loopStart, performance.now(), 0, 0, 0, renderCurrent); // Log skipped frame
      
    //   // Continue animation loop
    //   if (this.#animatedScales.size > 0) {
    //     this.#animationRafId = requestAnimationFrame(this.#animationLoop);
    //   } else {
    //     this.#animationActive = false;
    //     this.#animationRafId = null;
    //   }
    //   return; // Skip the render submission
    // }

    // await new Promise(resolve => setTimeout(resolve, 1));
    if (this.#inflightPromises.length >= this.#MAX_FRAMES_IN_FLIGHT) {
      await this.#inflightPromises[0]
      this.#inflightPromises.shift();
    }

    // Render
    const renderStart = performance.now();
    if (chartsToRender.size > 0) {
      const chartArray = this.#chartsToRenderArray;
      chartArray.length = 0;

      for (const chartId of chartsToRender) {
        const chart = this.#registeredCharts.get(chartId);
        if (chart?.visible && chart.contextConfigured) {
          chartArray.push(chart);
        }
      }
      this.#coordinatedRender(chartArray, this.#nextFrameId);
    }
    const renderEnd = performance.now();

    const loopEnd = performance.now();

    // Performance logging
    // this.perf.log(
    //   loopStart,
    //   loopEnd, 
    //   0, // scaleAnimationTime (you could measure this separately)
    //   renderEnd - renderStart, // renderTime
    //   0, // schedulingLag
    //   renderCurrent
    // );

    // Continue or end loop
    if (this.#animatedScales.size > 0) {
      this.#animationRafId = requestAnimationFrame(this.#animationLoop);
    } else {
      this.#animationActive = false;
      this.#animationRafId = null;
    }
  };

  /**
   * Create scale data from GPU state based on scale type
   * @private
   */
  #createScaleDataFromGpuState(gpuState, scaleType) {
    switch (scaleType) {
      case 'linear':
        return new Float32Array([
          gpuState.domainMin,           // Domain data only (shareable across charts)
          gpuState.domainMax,           
          gpuState.domainScale || (1.0 / (gpuState.domainMax - gpuState.domainMin)),
          0,                            // Padding to 16 bytes
        ]);
      
      case 'band':
        // Future: band scale specific data structure
        return new Float32Array([
          gpuState.domainMin || 0,
          gpuState.domainMax || (gpuState.categoryCount - 1),
          gpuState.categoryCount || 0,
          0, 0, 0, 0, 0,                // Padding
          0, 0, 0, 0                    // More padding to 48 bytes
        ]);
      
      default:
        console.warn(`Unknown scale type: ${scaleType}, using linear format`);
        return new Float32Array([
          gpuState.domainMin || 0,
          gpuState.domainMax || 1,
          0, 0, 1, 0, 0, 0
        ]);
    }
  }

  // ===== UPDATED: COORDINATED RENDER WITH SCALE INSTANCE BIND GROUPS =====

  async #coordinatedRender(chartsNeedingRender, frameId) {

    try {

      let stagingResult = null;

      // Update scales with staging buffer
      if (this.#animatedScales.size > 0) {
        // TODO this should not be async, we should move that guard up much earlier in the raf loop
        stagingResult = await this.#updateScaleSSBOWithStaging();
      }

      // if (this.#frameCompletionPromises.length >= 1) {
      // await this.#frameCompletionPromises.shift();
      // }

      // NOTE: This sync point will be eliminated with pre-recorded command buffers
      // await this.#device.queue.onSubmittedWorkDone();

      const commandEncoder = this.#device.createCommandEncoder({ label: 'frame-encoder' });


      // Copy staging to SSBO if we have scale updates
      if (stagingResult) {
        commandEncoder.copyBufferToBuffer(
          stagingResult.staging, 0,
          this.#globalScaleSSBO, stagingResult.dstOffset,
          this.#slotByteSize
        );
      }

      // TODO integrate these below instead of this.#globalScaleBindGroup
      const currentSlot = this.#frameId % this.#SSBO_SLOT_COUNT;
      const currentScaleBindGroup = this.#globalScaleBindGroups[currentSlot]
      // const currentScaleBindGroup = this.#createGlobalScaleBindGroup(currentSlot);


      for (const chartConfig of chartsNeedingRender) {

        if (chartConfig.needsPlanRebuild) {
          this.#buildRenderPlanForChart(chartConfig);
        }
        
        const passEncoder = commandEncoder.beginRenderPass(
          this.#createRenderPassDescriptor(
            chartConfig.context.getCurrentTexture().createView(),
            chartConfig.canvas,
            chartConfig.chartId
          )
        );
        
        // Get the per-frame bind group from the chart (shared by all layers)
        const chartPerFrameBindGroup = chartConfig.perFrameBindGroup;
        if (!chartPerFrameBindGroup) {
          console.debug(`Skipping render for chart ${chartConfig.chartId} - chart frame bind group not ready`);
          passEncoder.end();
          continue; // Skip to next chart
        }

        // Set the chart's frame bind group once (all layers in this chart will use it)
        passEncoder.setBindGroup(0, chartPerFrameBindGroup);

        // let currentPipeline = null;
        // let currentPerDataBindGroup = null;
        // let currentXScaleBindGroup = null;
        // let currentYScaleBindGroup = null;
        let currentPipeline = null;
        let currentPerDataBindGroup = null;
        // let currentGlobalScaleBindGroup = null;

        for (const layer of chartConfig.renderPlan) {
          const renderer = layer.renderer;
          
          // NEW: Only check for data bind groups (frame bind group is now chart-level)
          if (!renderer || !renderer.perDataBindGroup) {
            console.debug(`Skipping layer ${layer.id} - renderer data bind group not ready`);
            continue;
          }

          const pipelineToUse = layer.cachedPipeline;
          const perDataBindGroupToUse = renderer.perDataBindGroup;

          // const xScaleBindGroupToUse = this.getCurrentScaleBindGroup(chartConfig.xScaleId);
          // const yScaleBindGroupToUse = this.getCurrentScaleBindGroup(chartConfig.yScaleId);

          // if (!xScaleBindGroupToUse || !yScaleBindGroupToUse) {
          //   console.warn('Missing scale bind groups - dots will not render correctly');
          //   continue; // Skip this layer
          // }
          // Check global scale bind group instead of individual ones
          // if (!this.#globalScaleBindGroup) {
          //   console.warn('Global scale bind group not ready - dots will not render correctly');
          //   continue;
          // }

          // if (!pipelineToUse || !xScaleBindGroupToUse || !yScaleBindGroupToUse) {
          //   console.debug(`Skipping layer ${layer.id} - pipeline or scale bind groups not ready`);
          //   continue;
          // }

          // Set pipeline only if different
          if (pipelineToUse !== currentPipeline) {
            passEncoder.setPipeline(pipelineToUse);
            currentPipeline = pipelineToUse;
          }
          
          if (perDataBindGroupToUse !== currentPerDataBindGroup) {
            passEncoder.setBindGroup(1, perDataBindGroupToUse);
            currentPerDataBindGroup = perDataBindGroupToUse;
          }

          // // Set X scale bind group (@group(2)) if different
          // if (xScaleBindGroupToUse !== currentXScaleBindGroup) {
          //   passEncoder.setBindGroup(2, xScaleBindGroupToUse);
          //   currentXScaleBindGroup = xScaleBindGroupToUse;
          // }

          // // Set Y scale bind group (@group(3)) if different  
          // if (yScaleBindGroupToUse !== currentYScaleBindGroup) {
          //   passEncoder.setBindGroup(3, yScaleBindGroupToUse);
          //   currentYScaleBindGroup = yScaleBindGroupToUse;
          // }

          // Set global scale bind group (@group(2)) - single bind group for all scales
          // if (this.#globalScaleBindGroup !== currentGlobalScaleBindGroup) {
          //   passEncoder.setBindGroup(2, this.#globalScaleBindGroup);
          //   currentGlobalScaleBindGroup = this.#globalScaleBindGroup;
          // }
          passEncoder.setBindGroup(2, currentScaleBindGroup);
          
          layer.draw(passEncoder);
        }
        passEncoder.end();
      }

      // Unmap staging before submit
      if (stagingResult) {
        stagingResult.staging.unmap();
      }

      this.#device.queue.submit([commandEncoder.finish()]);


      // Async remap staging back to pool
      if (stagingResult) {
        const p = this.#device.queue.onSubmittedWorkDone().then(() => {
          return stagingResult.staging.mapAsync(GPUMapMode.WRITE).then(() => {
            this.#stagingPool.push(stagingResult.staging);
          });
        });
        this.#inflightPromises.push(p);
      }
      
      this.#frameId++;
      
      // Track this frame's completion
      // const completionPromise = this.#device.queue.onSubmittedWorkDone();
      // this.#frameCompletionPromises.push(completionPromise);

      // const submitTime = performance.now();
      // this.#frameCompletionPromises.push(
      //   this.#device.queue.onSubmittedWorkDone().then(() => {
      //     console.log(`GPU frame took ${performance.now() - submitTime}ms`);
      //   })
      // );
      // --- SAFETY TRACKING ---
      // Record that this frameId is now using the current buffer
      // this.#lastFrameUsingBuffer[this.#bufferCycle.currentIndex] = frameId;
      
      // Track this frame's completion for cleanup
      // const completionPromise = this.#device.queue.onSubmittedWorkDone();
      // completionPromise.then(() => {
      //   // When GPU finishes this frame, remove it from tracking
      //   this.#frameCompletionPromises.delete(frameId);
      // });
      
      // Store the promise so we can check if frame is still running
      // this.#frameCompletionPromises.set(frameId, completionPromise);
      // this.#frameCompletionPromises.push(completionPromise);
      // this.#renderCount = (this.#renderCount || 0) + 1;
      
    } catch (error) {
      console.error('Coordinated render failed:', error);
      this.#fallbackRender(chartsNeedingRender);
    }
  }

  /**
   * Fallback rendering when coordinated render fails
   * @private
   */
  #fallbackRender(chartsNeedingRender) {
    console.warn('Using fallback render path');
    for (const chartConfig of chartsNeedingRender) {
      try {
        const commandEncoder = this.#device.createCommandEncoder();
        const passEncoder = commandEncoder.beginRenderPass(
          this.#createRenderPassDescriptor(
            chartConfig.context.getCurrentTexture().createView(),
            chartConfig.canvas,
            chartConfig.chartId
          )
        );

        const chartPerFrameBindGroup = chartConfig.perFrameBindGroup;
        if (!chartPerFrameBindGroup) {
          passEncoder.end();
          continue;
        }


        for (const layer of chartConfig.layers.values()) {
          const renderer = layer.renderer;
          if (renderer?.pipeline && renderer?.perFrameBindGroup && renderer?.perDataBindGroup) {
            // const xScaleId = renderer.chartContext?.xScaleState?.id;
            // const yScaleId = renderer.chartContext?.yScaleState?.id;
            // const xScaleBindGroup = this.getCurrentScaleBindGroup(chartConfig.xScaleId);
            // const yScaleBindGroup = this.getCurrentScaleBindGroup(chartConfig.yScaleId);

            // const xScaleBindGroup = xScaleId ? this.getCurrentScaleBindGroup(xScaleId) : null;
            // const yScaleBindGroup = yScaleId ? this.getCurrentScaleBindGroup(yScaleId) : null;
            
            if (xScaleBindGroup && yScaleBindGroup) {
              passEncoder.setPipeline(renderer.pipeline);
              // passEncoder.setBindGroup(0, renderer.perFrameBindGroup);
              passEncoder.setBindGroup(0, chartPerFrameBindGroup); 
              passEncoder.setBindGroup(1, renderer.perDataBindGroup);
              passEncoder.setBindGroup(2, xScaleBindGroup);
              passEncoder.setBindGroup(3, yScaleBindGroup);
              layer.draw(passEncoder);
            }
          }
        }
        passEncoder.end();
        this.#device.queue.submit([commandEncoder.finish()]);
      } catch (error) {
        console.error(`Failed to render chart ${chartConfig.chartId}:`, error);
      }
    }
  }

  /**
   * Get chart context for a layer (helper method)
   * @private
   */
  #getChartContextForLayer(layer) {
    // Access chart context through the renderer
    return layer.renderer?.chartContext || null;
  }

  // ===== CHART MANAGEMENT =====

  setScaleRegistry(scaleRegistry) {
    this.#scaleRegistry = scaleRegistry;
  }

  #getChartsUsingScale(scale) {
    if (!this.#scaleRegistry?.scaleUsage) return new Set();
    return this.#scaleRegistry.scaleUsage.get(scale) || new Set();
  }

  /**
   * Update the scale ID mapping for a specific chart
   * Called by ChartScales when scale instances are resolved or change
   */
  setChartScaleMapping(chartId, { xScaleId, yScaleId }) {
    const chartConfig = this.#registeredCharts.get(chartId);
    if (!chartConfig) {
      // Queue the mapping for when chart is registered
      console.debug(`Queueing scale mapping for unregistered chart ${chartId}`);
      this.#pendingScaleMappings.set(chartId, { xScaleId, yScaleId });
      return;
    }

    const changed = chartConfig.xScaleId !== xScaleId || chartConfig.yScaleId !== yScaleId;
    
    chartConfig.xScaleId = xScaleId;
    chartConfig.yScaleId = yScaleId;
    
    if (changed) {
      console.debug(`Updated scale mapping for chart ${chartId}:`, { xScaleId, yScaleId });
      
      // Trigger rebuild of render plan since scale bindings may have changed
      chartConfig.needsPlanRebuild = true;
      this.invalidateChart(chartId);
    }
}

  invalidateChart(chartId) {
    if (this.#registeredCharts.has(chartId)) {
      this.#dirtyChartIDs.add(chartId);
      this.#ensureLoopIsActive();
    }
  }

  addAnimatingScale(scale) {
    // Buffer pool should already exist from scale creation
    // if (!this.#scaleInstancePools.has(scale.id)) {
    //   console.error(`No buffer pool found for scale ${scale.id} - should have been created in constructor`);
    //   return;
    // }
    const globalIndex = this.#scaleIndexManager.getIndex(scale.id);
    if (globalIndex === undefined) {
      console.error(`Scale ${scale.id} not registered in global SSBO system - call createBufferPoolForScale first`);
      return;
    }
    
    this.#animatedScales.add(scale);
    this.#ensureLoopIsActive();
  }

  removeAnimatingScale(scale) {
    this.#animatedScales.delete(scale);
  }

  #ensureLoopIsActive() {
    if (this.#animationRafId) return;

    if (this.#animatedScales.size > 0 && !this.#animationActive) {
      this.#animationActive = true;
      this.#accumulator = 0;
      this.#lastFrameTime = 0;
    }

    this.#animationRafId = requestAnimationFrame(this.#animationLoop);
  }

  registerChart(chartId, canvas, config) {
    if (this.#registeredCharts.has(chartId)) {
      console.warn(`Chart ${chartId} already registered, updating config`);
    }

    const chartConfig = {
      chartId,
      canvas,
      zIndex: config.zIndex || 0,
      visible: true,
      context: canvas.getContext('webgpu'),
      contextConfigured: false,
      layers: new Map(),
      renderPlan: [],
      needsPlanRebuild: true,
      xScaleId: null,
      yScaleId: null,
      frameUniformsBuffer: null,
      perFrameBindGroup: null,
    };

    this.#registeredCharts.set(chartId, chartConfig);

    // Process any pending scale mappings for this chart
    const pendingMapping = this.#pendingScaleMappings.get(chartId);
    if (pendingMapping) {
      console.debug(`Applying queued scale mapping for chart ${chartId}:`, pendingMapping);
      this.setChartScaleMapping(chartId, pendingMapping);
      this.#pendingScaleMappings.delete(chartId);
    }

    return {
      setContextReady: () => {
        const chart = this.#registeredCharts.get(chartId);
        if (chart) {
          chart.contextConfigured = true;
          this.#processPendingFrameUpdates(chartId);
        }
      },
      setVisible: (visible) => {
        const config = this.#registeredCharts.get(chartId);
        if (config && config.visible !== visible) {
          config.visible = visible;
          this.invalidateChart(chartId);
        }
      },
      invalidate: () => {
        this.invalidateChart(chartId);
      },
      remove: () => {
        this.unregisterChart(chartId);
      }
    };
  }

  unregisterChart(chartId) {
    const chartConfig = this.#registeredCharts.get(chartId);
    if (chartConfig) {
      // NEW: Clean up per-chart frame resources
      if (chartConfig.frameUniformsBuffer && !chartConfig.frameUniformsBuffer.destroyed) {
        chartConfig.frameUniformsBuffer.destroy();
      }
      // Note: perFrameBindGroup doesn't need explicit cleanup

      this.#registeredCharts.delete(chartId);

      // Existing MSAA cleanup
      const msaa = this.#msaaCache.get(chartId);
      if (msaa) {
        msaa.texture.destroy();
        this.#msaaCache.delete(chartId);
        console.debug(`Destroyed cached MSAA resources for chart: ${chartId}`);
      }

      // Existing pending mappings cleanup
      this.#pendingScaleMappings.delete(chartId);

      console.log(`Unregistered chart: ${chartId}`);
    }
  }

  registerLayer(chartId, layerConfig) {
    const chart = this.#registeredCharts.get(chartId);
    if (!chart) {
      console.error(`Attempted to register layer on non-existent chart: ${chartId}`);
      return { remove: () => {} };
    }

    const layerId = layerConfig.id || `layer-${crypto.randomUUID().slice(0, 8)}`;
    chart.layers.set(layerId, { ...layerConfig, id: layerId, zIndex: layerConfig.zIndex ?? 0 });

    chart.needsPlanRebuild = true;
    console.log(`📋 Layer registered: chart ${chartId} now has ${chart.layers.size} layers, needsPlanRebuild=${chart.needsPlanRebuild}`);
    this.invalidateChart(chartId);

    return {
      remove: () => this.unregisterLayer(chartId, layerId)
    };
  }

  unregisterLayer(chartId, layerId) {
    const chart = this.#registeredCharts.get(chartId);
    if (chart?.layers.has(layerId)) {
      chart.layers.delete(layerId);
      chart.needsPlanRebuild = true;
      this.invalidateChart(chartId);
    }
  }

  #buildRenderPlanForChart(chartConfig) {
    // console.log(`🏗️ Building render plan for chart ${chartConfig.chartId}: ${chartConfig.layers.size} layers available`);
  
    const layers = Array.from(chartConfig.layers.values());
    if (layers.length === 0) {
      console.log(`⚠️ No layers to render for chart ${chartConfig.chartId}`);
      chartConfig.renderPlan = [];
      chartConfig.needsPlanRebuild = false;
      return;
    }

    const zIndexGroups = new Map();
    for (const layer of layers) {
      const zIndex = layer.zIndex;
      if (!zIndexGroups.has(zIndex)) zIndexGroups.set(zIndex, []);
      zIndexGroups.get(zIndex).push(layer);
    }

    const sortedZLevels = Array.from(zIndexGroups.keys()).sort((a, b) => a - b);
    const newPlan = [];
    for (const zLevel of sortedZLevels) {
      const layersInZLevel = zIndexGroups.get(zLevel);
      const markTypeGroups = new Map();
      for (const layer of layersInZLevel) {
        const markType = layer.markType || 'unknown';
        if (!markTypeGroups.has(markType)) markTypeGroups.set(markType, []);
        markTypeGroups.get(markType).push(layer);
      }
      for (const batchedLayers of markTypeGroups.values()) {
        newPlan.push(...batchedLayers);
      }
    }

    // Enrich the plan with cached references
    for (const layer of newPlan) {
      layer.cachedPipeline = layer.renderer?.pipeline;
      layer.cachedPerFrameBindGroup = layer.renderer?.perFrameBindGroup;
      layer.cachedPerDataBindGroup = layer.renderer?.perDataBindGroup;
      layer.isDualBindGroupReady = !!(layer.cachedPerFrameBindGroup && layer.cachedPerDataBindGroup);
    }

    chartConfig.renderPlan = newPlan;
    chartConfig.needsPlanRebuild = false;
    // console.log(`✅ Render plan built for chart ${chartConfig.chartId}: ${newPlan.length} layers in plan`);
  }

  #createRenderPassDescriptor(textureView, canvas, chartId) {
    if (this.#msaaSampleCount > 1) {
      let msaa = this.#msaaCache.get(chartId);

      if (!msaa || 
          msaa.texture.width !== canvas.width ||
          msaa.texture.height !== canvas.height) {
          
        msaa?.texture.destroy();
        
        const newTexture = this.#device.createTexture({
          size: { width: canvas.width, height: canvas.height },
          sampleCount: this.#msaaSampleCount,
          format: this.#presentationFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT
        });

        msaa = {
          texture: newTexture,
          view: newTexture.createView() 
        };

        this.#msaaCache.set(chartId, msaa);
      }

      return {
        colorAttachments: [{
          view: msaa.view, 
          resolveTarget: textureView,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      };
    } else {
      return {
        colorAttachments: [{
          view: textureView,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      };
    }
  }

  #getOrCreateDataLayout(markType, dataBindingConfig) {
    const layoutKey = `${markType}-${JSON.stringify(dataBindingConfig)}`;
    
    if (!this.#dataLayouts.has(layoutKey)) {
      const layout = this.#device.createBindGroupLayout({
        label: `${markType}-data-layout`,
        entries: dataBindingConfig.map(config => ({
          binding: config.binding,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: config.type || 'read-only-storage' }
        }))
      });
      this.#dataLayouts.set(layoutKey, layout);
    }
    
    return this.#dataLayouts.get(layoutKey);
  }

  async createPipelineForMarkType(markType, scaleTypes, markShaderCode, vertexBufferLayout, dataBindingConfig) {
    console.log(`Creating pipeline for ${markType} with scales: ${scaleTypes.x}-${scaleTypes.y}`);

    // Generate shader using template system
    const templateResult = scaleTemplateSystem.generateShader(scaleTypes, markShaderCode);
    
    // Get or create stable layouts
    const frameLayout = this.#getOrCreateFrameLayout();
    const dataLayout = this.#getOrCreateDataLayout(markType, dataBindingConfig);
    // const xScaleLayout = this.#scaleBindGroupLayouts.get(scaleTypes.x);
    // const yScaleLayout = this.#scaleBindGroupLayouts.get(scaleTypes.y);

    // if (!xScaleLayout || !yScaleLayout) {
    //   throw new Error(`Scale bind group layouts not found for types: ${scaleTypes.x}, ${scaleTypes.y}`);
    // }

    // Use global SSBO layout for both X and Y scales
    const globalScaleLayout = this.#scaleBindGroupLayouts.get('global');

    if (!globalScaleLayout) {
      throw new Error('Global scale SSBO layout not found - ensure SSBO system is initialized');
    }

    // Create pipeline layout
    const pipelineLayout = this.#device.createPipelineLayout({
      label: `${markType}-pipeline-layout`,
      // bindGroupLayouts: [frameLayout, dataLayout, xScaleLayout, yScaleLayout]
      bindGroupLayouts: [frameLayout, dataLayout, globalScaleLayout]
    });

    // Create or get shared shader
    console.log('🏭 Creating shader module...');
    const shaderModule = await this.getOrCreateSharedShader(markType, templateResult.shaderCode);
    console.log('🏭 Shader module created successfully');

    // Create pipeline
    console.log('🏭 Creating render pipeline...');
    const pipeline = await this.getOrCreateSharedPipeline(
      `${markType}-${scaleTypes.x}-${scaleTypes.y}`, // Include scale types in cache key
      async () => {
        const msaaSampleCount = this.#msaaSampleCount;

        console.log('🏭 Pipeline config:', {
          msaa: msaaSampleCount,
          format: this.#presentationFormat,
          vertexBuffers: vertexBufferLayout?.length || 0
        });
        
        return this.#device.createRenderPipeline({
          label: `${markType}-${scaleTypes.x}-${scaleTypes.y}-pipeline`,
          layout: pipelineLayout,
          vertex: {
            module: shaderModule,
            entryPoint: 'vertexMain',
            buffers: vertexBufferLayout || [],
          },
          fragment: {
            module: shaderModule,
            entryPoint: 'fragmentMain',
            targets: [{
              format: this.#presentationFormat,
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

     console.log('🏭 Pipeline created successfully');

    return {
      pipeline,
      frameLayout,
      dataLayout
    };
  }

  // ===== SHARED RESOURCE METHODS WITH REFERENCE COUNTING =====

  async getOrCreateSharedPipeline(markType, createFn) {
    console.log(`Pipeline request for ${markType}, existing:`, !!this.#sharedResources.pipelines.get(markType));
  
    const existing = this.#sharedResources.pipelines.get(markType);
    
    if (existing) {
      existing.refCount++;
      return existing.pipeline;
    }

    // Check if already creating to prevent race conditions
    if (this.#creatingPipelines.has(markType)) {
      // Wait for the other creation to complete
      while (this.#creatingPipelines.has(markType)) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // Now get the created pipeline
      const newExisting = this.#sharedResources.pipelines.get(markType);
      if (newExisting) {
        newExisting.refCount++;
        console.log(`Pipeline request for ${markType}, was reused after creation:`, !!this.#sharedResources.pipelines.get(markType));
        return newExisting.pipeline;
      }
    }

    // Mark as creating
    this.#creatingPipelines.add(markType);

    try {
      console.log(`Creating new pipeline for ${markType}`);
      const pipeline = await createFn();
      
      this.#sharedResources.pipelines.set(markType, {
        pipeline,
        refCount: 1,
        createdAt: Date.now()
      });

      return pipeline;
    } finally {
      this.#creatingPipelines.delete(markType);
    }
  }

  releaseSharedPipeline(markType) {
    const resource = this.#sharedResources.pipelines.get(markType);
    if (!resource) return;

    resource.refCount--;

    if (resource.refCount <= 0) {
      this.#sharedResources.pipelines.delete(markType);
      console.log(`Released shared pipeline: ${markType}`);
    }
  }

  async getOrCreateSharedShader(markType, shaderCode) {
    const existing = this.#sharedResources.shaderModules.get(markType);
    
    if (existing) {
      existing.refCount++;
      return existing.module;
    }

    const module = this.#device.createShaderModule({ code: shaderCode });
    
    this.#sharedResources.shaderModules.set(markType, {
      module,
      refCount: 1,
      createdAt: Date.now()
    });

    return module;
  }

  releaseSharedShader(markType) {
    const resource = this.#sharedResources.shaderModules.get(markType);
    if (!resource) return;

    resource.refCount--;

    if (resource.refCount <= 0) {
      this.#sharedResources.shaderModules.delete(markType);
      console.log(`Released shared shader: ${markType}`);
    }
  }

  getSharedUniformBuffer(name) {
    const resource = this.#sharedResources.uniformBuffers.get(name);
    if (resource) {
      resource.refCount++;
      return resource.buffer;
    }
    return null;
  }

  releaseSharedUniformBuffer(name) {
    const resource = this.#sharedResources.uniformBuffers.get(name);
    if (resource) {
      resource.refCount--;
      
      if (resource.refCount <= 0) {
        if (resource.buffer && !resource.buffer._isDestroyed) {
          resource.buffer.destroy();
        }
        this.#sharedResources.uniformBuffers.delete(name);
        console.log(`Released shared uniform buffer: ${name}`);
      }
    }
  }

  // Legacy getters for backward compatibility
  getSharedPipeline(markType) {
    return this.#sharedResources.pipelines.get(markType)?.pipeline;
  }

  getSharedShaderModule(markType) {
    return this.#sharedResources.shaderModules.get(markType)?.module;
  }

  // Getters
  get device() { return this.#device; }
  get presentationFormat() { return this.#presentationFormat; }
  get msaaSampleCount() { return this.#msaaSampleCount; }
  get isInitialized() { return this.#initialized; }

  // ===== INITIALIZATION METHODS =====

  async #initWebGPU() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      throw new Error('WebGPU initialization attempted server-side');
    }

    if (!navigator.gpu) {
      throw new Error('WebGPU not supported');
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance"
    });

    if (!adapter) {
      throw new Error('No appropriate GPUAdapter found');
    }

    this.#device = await adapter.requestDevice();
    this.#presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  }

  async #createSharedResources() {
    const device = this.#device;

    const dprBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#sharedResources.uniformBuffers.set('devicePixelRatio', {
      buffer: dprBuffer,
      refCount: 0,
      createdAt: Date.now()
    });

    this.#updateSharedUniforms();
  }

  #updateSharedUniforms() {
    if (!this.#device) return;

    const devicePixelRatio = window.devicePixelRatio || 1;
    const dprResource = this.#sharedResources.uniformBuffers.get('devicePixelRatio');

    if (dprResource?.buffer) {
      this.#device.queue.writeBuffer(dprResource.buffer, 0, new Float32Array([devicePixelRatio]));
    }
  }

  // ===== COMPREHENSIVE CLEANUP =====

  destroy() {
    console.log('Destroying GPUCoordinator with comprehensive cleanup');
    
    // Stop animation loop
    if (this.#animationRafId !== null) {
      cancelAnimationFrame(this.#animationRafId);
      this.#animationRafId = null;
    }
    
    this.#animationActive = false;
    this.#animatedScales.clear();

    // NEW: Cleanup scale instance pools
    for (const [scaleId, pool] of this.#scaleInstancePools) {
      pool.buffers.forEach(buffer => {
        if (!buffer.destroyed) {
          buffer.destroy();
        }
      });
    }
    this.#scaleInstancePools.clear();

    // Cleanup MSAA textures
    for (const msaa of this.#msaaCache.values()) {
      if (msaa.texture && !msaa.texture.destroyed) {
        msaa.texture.destroy();
      }
    }
    this.#msaaCache.clear();

    // Cleanup shared resources with reference counting
    for (const [name, resource] of this.#sharedResources.uniformBuffers) {
      if (resource.buffer && !resource.buffer._isDestroyed) {
        resource.buffer.destroy();
      }
    }
    this.#sharedResources.uniformBuffers.clear();
    this.#sharedResources.pipelines.clear();
    this.#sharedResources.shaderModules.clear();
    this.#sharedResources.bindGroupLayouts.clear();

    // Cleanup bind group layouts
    this.#scaleBindGroupLayouts.clear();

    // Cleanup charts and layers
    this.#registeredCharts.clear();
    this.#dirtyChartIDs.clear();

    // Cleanup performance tracking
    this.#frameHistory = [];
    this.#frameTimings = [];

    // Cleanup race condition protection
    this.#creatingPipelines.clear();

    // Clean up layouts
    this.#dataLayouts.clear();
    this.#frameLayout = null;

    this.#pendingScaleMappings.clear();

    // Destroy device last
    if (this.#device) {
      this.#device.destroy();
      this.#device = null;
    }

    this.#initialized = false;
    console.log('GPUCoordinator destruction complete');
  }
}

// Context functions remain unchanged...
export function setGPUCoordinator(config = {}) {
  const coordinator = new GPUCoordinator(config);
  
  if (typeof window !== 'undefined') {
    coordinator.initialize().catch(error => {
      console.error('Failed to initialize GPU coordinator:', error);
    });
  }
  
  return setContext('gpu-coordinator', coordinator);
}

export function getGPUContext() {
  const coordinator = getContext('gpu-coordinator');
  
  if (!coordinator) {
    console.error('GPU Coordinator context missing. Make sure to call setGPUCoordinator() in a parent component.');
    return null;
  }
  
  return coordinator;
}

// MinimalPerfLogger class remains unchanged...
class MinimalPerfLogger {
  constructor(maxSamples = 10000) {
    this.timestamps = new Float64Array(maxSamples);
    this.frameDeltas = new Float32Array(maxSamples);
    this.cpuTimes = new Float32Array(maxSamples);
    this.scaleAnimationTimes = new Float32Array(maxSamples);
    this.renderTimes = new Float32Array(maxSamples);
    this.schedulingLags = new Float32Array(maxSamples);
    this.renderDomains = new Float32Array(maxSamples);
    
    this.index = 0;
    this.maxSamples = maxSamples;
    this.startTime = performance.now();
    this.lastFrameTime = 0;
    this.bufferFullWarned = false;
  }
  
  log(loopStart, loopEnd, scaleAnimationTime = 0, renderTime = 0, schedulingLag = 0, renderDomain = []) {
    if (this.index >= this.maxSamples) {
      if (!this.bufferFullWarned) {
        console.warn(`PerformanceLogger: Buffer full (${this.maxSamples} samples). Data collection stopped.`);
        this.bufferFullWarned = true;
      }
      return;
    }
    
    const i = this.index++;
    this.timestamps[i] = loopStart - this.startTime;
    this.cpuTimes[i] = loopEnd - loopStart;
    this.scaleAnimationTimes[i] = scaleAnimationTime;
    this.renderTimes[i] = renderTime;
    this.schedulingLags[i] = schedulingLag;
    this.renderDomains[i] = renderDomain;
    
    if (this.lastFrameTime > 0) {
      this.frameDeltas[i] = loopStart - this.lastFrameTime;
    }
    
    this.lastFrameTime = loopStart;
  }
  
  export() {
    const activeLength = Math.min(this.index, this.maxSamples);
    
    const rows = [];
    for (let i = 0; i < activeLength; i++) {
      rows.push({
        timestamp: this.timestamps[i],
        frameDelta: this.frameDeltas[i],
        cpuTime: this.cpuTimes[i],
        scaleAnimationTime: this.scaleAnimationTimes[i],
        renderTime: this.renderTimes[i],
        schedulingLag: this.schedulingLags[i],
        renderDomain: this.renderDomains[i],
      });
    }
    
    return rows;
  }
  
  downloadJSON() {
    const blob = new Blob([JSON.stringify(this.export())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `perf-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  
  reset() {
    this.index = 0;
    this.startTime = performance.now();
    this.lastFrameTime = 0;
  }
}