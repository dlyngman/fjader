import { setContext, getContext } from 'svelte';

const TIMESTEP = 1000 / 240; // 60Hz physics clock (~16.667ms)

/**
 * Manages all WebGPU resources, layers, and render scheduling for the dashboard.
 * Implements a "Managed Loop" for high-performance, on-demand rendering and
 * a cached "Render Plan" to keep the per-frame render path extremely lean.
 * 
*/
export class GPUCoordinator {
  // WebGPU core resources
  #device = $state(null);
  #presentationFormat = $state(null);
  #initialized = $state(false);

  // Enhanced shared resources with reference counting
  #sharedResources = $state({
    pipelines: new Map(),           // 'dots' -> { pipeline, refCount, createdAt }
    uniformBuffers: new Map(),      // 'devicePixelRatio' -> { buffer, refCount, createdAt }
    shaderModules: new Map(),       // 'dots' -> { module, refCount, createdAt }
    bindGroupLayouts: new Map()     // 'dots' -> { layout, refCount, createdAt }
  });

  // Chart registration and management
  #registeredCharts = $state(new Map());

  // Map for caching MSAA textures
  #msaaTextures = new Map(); // TODO old cache remove
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

  // Configuration
  // #msaaSampleCount = 4;
  #msaaSampleCount = 4;
  lastRender;

  #frameHistory = [];
  #renderCount = 0;

  #frameTimings = [];

  #creatingPipelines = new Set();

  #smoothedDeltaTime = 8.3; // Initialize to ideal 60fps
  #smoothingFactor = 0.05; // Adjust this value (0.05 to 0.2 is a good range)

  #globalInputDelay = 0;

  constructor(config = {}) {
    this.#msaaSampleCount = config.msaaSampleCount ?? 4;

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
      this.#initialized = true;
      console.log('✅ GPUCoordinator initialized successfully');
    } catch (error) {
      console.error('❌ GPUCoordinator initialization failed:', error);
      throw error;
    }
  }

  // Method to inject scale registry reference
  setScaleRegistry(scaleRegistry) {
    this.#scaleRegistry = scaleRegistry;
  }

  // Helper to get charts using a scale
  #getChartsUsingScale(scale) {
    if (!this.#scaleRegistry?.scaleUsage) return new Set();
    return this.#scaleRegistry.scaleUsage.get(scale) || new Set();
  }

  invalidateChart(chartId) {
    if (this.#registeredCharts.has(chartId)) {
        this.#dirtyChartIDs.add(chartId);
        this.#ensureLoopIsActive();
    }
  }

  #scheduleRender() {
    // If a frame isn't already scheduled, request one.
    // The #animationActive flag is now just for the physics loop.
    if (!this.#animationRafId) {
        this.#animationRafId = requestAnimationFrame(this.#animationLoop);
    }
  } 
  
  addAnimatingScale(scale) {
    this.#animatedScales.add(scale);
    this.#ensureLoopIsActive(); // Also ensures the loop is running
  }

  removeAnimatingScale(scale) {
    this.#animatedScales.delete(scale);
  }

  #ensureLoopIsActive() {
    if (this.#animationRafId) return; // Loop already scheduled

    // For the very first frame of an animation, reset timing.
    if (this.#animatedScales.size > 0 && !this.#animationActive) {
        this.#animationActive = true;
        this.#accumulator = 0;
        this.#lastFrameTime = 0;
    }

    this.#animationRafId = requestAnimationFrame(this.#animationLoop);
  }

  #animationLoop = (currentTime) => {
    
    const loopStart = performance.now();
    
    // 1. MEASURE REAL TIME
    const now = performance.now(); // Using performance.now() rather than raf timing, inspired by https://github.com/sveltejs/svelte/pull/14541
    // const now = currentTime;
    if (this.#lastFrameTime === 0) this.#lastFrameTime = now;
    let deltaTime = now - this.#lastFrameTime;
    this.#lastFrameTime = now;
    
    console.log('new frame', deltaTime)
    // if (this.#animatedScales.size > 0) {
    //   console.log(`Delta: ${deltaTime.toFixed(2)}ms (FPS: ${(1000 / deltaTime).toFixed(0)})`);
    // }

    if (deltaTime < 0) deltaTime = 8.3;
    if (deltaTime > 250) deltaTime = 250; // Clamp to prevent spiral-of-death on tab resume

    // // 1. MEASURE REAL TIME
    // if (this.#lastFrameTime === 0) this.#lastFrameTime = currentTime;
    // let deltaTime = currentTime - this.#lastFrameTime;

    // if (this.#animatedScales.size > 0) {
    //   console.log(`Delta: ${deltaTime.toFixed(2)}ms (FPS: ${(1000 / deltaTime).toFixed(0)})`);
    // }


    // this.#lastFrameTime = currentTime;
    // if (deltaTime > 250) deltaTime = 250; // Clamp to prevent spiral-of-death on tab resume

    
    // 2. ACCUMULATE TIME
    // this.#smoothedDeltaTime = this.#smoothingFactor * deltaTime + (1 - this.#smoothingFactor) * this.#smoothedDeltaTime;
    this.#accumulator += deltaTime;
    // this.#accumulator += this.#smoothedDeltaTime;

    
    // 4. RUN FIXED-STEP PHYSICS LOOP
    while (this.#accumulator >= TIMESTEP) {
      // 3. APPLY LATEST USER INPUT (once per frame)
      for (const scale of this.#animatedScales) {
        // Process scheduled input first
        const scheduledProcessed = scale._processScheduledInput?.(now, this.#globalInputDelay);
        
        // Then handle immediate input (zoom) if no scheduled input was processed
        if (!scheduledProcessed && scale._applyInput) {
          scale._applyInput(now);
        }
        // if (scale._applyInput) {
        //   scale._applyInput(now);
        // }
      }

      for (const scale of this.#animatedScales) {
        if (scale._updatePhysics) {
          scale._updatePhysics(TIMESTEP);
        }
      }
      this.#accumulator -= TIMESTEP;
    }

    // 5. PREPARE FOR RENDER WITH INTERPOLATION
    const alpha = this.#accumulator / TIMESTEP;
    const chartsToRender = this.#chartsToRenderSet;
    chartsToRender.clear();
    // const chartsToRender = new Set();
    
    let renderCurrent;
    for (const scale of this.#animatedScales) {
      // if (scale._setRenderState) {
      renderCurrent = scale._setRenderState(alpha); // just write over in case several scales animting, only log one
      console.log('renderCurrent', renderCurrent)
      // }
      const affectedCharts = this.#getChartsUsingScale(scale);
      affectedCharts.forEach(chartId => chartsToRender.add(chartId));
    }


    // Add any charts that were dirtied by non-animation events
    this.#dirtyChartIDs.forEach(id => chartsToRender.add(id));
    this.#dirtyChartIDs.clear();

    // 6. RENDER
    const renderStart = performance.now();
    if (chartsToRender.size > 0) {
      // const chartArray = [];
      const chartArray = this.#chartsToRenderArray;
      chartArray.length = 0;

      for (const chartId of chartsToRender) {
        const chart = this.#registeredCharts.get(chartId);
        if (chart?.visible && chart.contextConfigured) {
          chartArray.push(chart);
        }
      }
      this.#coordinatedRender(chartArray);
    }
    const renderEnd = performance.now();

    const loopEnd = performance.now();

    // this.perf.log(
    //   loopStart,
    //   loopEnd, 
    //   0, // scaleAnimationTime (you could measure this separately)
    //   renderEnd - renderStart, // renderTime
    //   0, // schedulingLag
    //   renderCurrent[0]
    // );


    // 7. CONTINUE OR END LOOP
    if (this.#animatedScales.size > 0) {
      this.#animationRafId = requestAnimationFrame(this.#animationLoop);
    } else {
      this.#animationActive = false;
      this.#animationRafId = null;
    }
  };

  // Schedule immediate render (extracted for reuse)
  // #scheduleImmediateRender() {
  //   if (!this.#renderScheduled) {
  //     this.#renderScheduled = true;
  //     requestAnimationFrame(() => {
  //       this.#renderScheduled = false;
  //       const chartsToRender = [];
  //       for (const chartId of this.#dirtyChartIDs) {
  //         const chart = this.#registeredCharts.get(chartId);
  //         if (chart?.visible && chart.contextConfigured) {
  //           chartsToRender.push(chart);
  //         }
  //       }
  //       this.#coordinatedRender(chartsToRender);
  //       this.#dirtyChartIDs.clear();
  //     });
  //   }
  // }

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
        renderPlan: [],       // Holds the pre-sorted, ready-to-render layer list
        needsPlanRebuild: true // Signals when the render plan is stale
    };

    this.#registeredCharts.set(chartId, chartConfig);

    return {
        setContextReady: () => {
          const chart = this.#registeredCharts.get(chartId);
          if (chart) chart.contextConfigured = true;
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
    if (this.#registeredCharts.has(chartId)) {
      this.#registeredCharts.delete(chartId);

      // Clean up the cached MSAA texture when a chart is unregistered
      const msaa = this.#msaaCache.get(chartId);
      if (msaa) {
        msaa.texture.destroy();
        this.#msaaCache.delete(chartId);
        console.debug(`🗑️ Destroyed cached MSAA resources for chart: ${chartId}`);
      }

      // console.log(`📊 Unregistered chart: ${chartId}`);
    }
  }

  registerLayer(chartId, layerConfig) {
    const chart = this.#registeredCharts.get(chartId);
    if (!chart) {
        console.error(`Attempted to register layer on non-existent chart: ${chartId}`);
        return { remove: () => {} };
    }

    // Use a unique ID for the layer for easy removal.
    const layerId = layerConfig.id || `layer-${crypto.randomUUID().slice(0, 8)}`;
    chart.layers.set(layerId, { ...layerConfig, id: layerId, zIndex: layerConfig.zIndex ?? 0 });

    chart.needsPlanRebuild = true; // The layer structure has changed
    this.invalidateChart(chartId); // Invalidate the chart to ensure the new layer is drawn.

    return {
        remove: () => this.unregisterLayer(chartId, layerId)
    };
  }

  unregisterLayer(chartId, layerId) {
    const chart = this.#registeredCharts.get(chartId);
    if (chart?.layers.has(layerId)) {
        chart.layers.delete(layerId);
        chart.needsPlanRebuild = true; // The layer structure has changed
        this.invalidateChart(chartId); // Invalidate to render the chart without the layer.
    }
  }

  /**
   * Builds a sorted and batched "Render Plan" for a chart.
   * This is run only when a chart's layer structure changes, not on every frame.
   */
  #buildRenderPlanForChart(chartConfig) {
    const layers = Array.from(chartConfig.layers.values());
    if (layers.length === 0) {
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
        // Within a Z-level, we can still batch by markType for performance
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

    // ✅ UPDATED: Enrich the plan with cached dual bind group references
    for (const layer of newPlan) {
        layer.cachedPipeline = layer.renderer?.pipeline;
        layer.cachedPerFrameBindGroup = layer.renderer?.perFrameBindGroup;
        layer.cachedPerDataBindGroup = layer.renderer?.perDataBindGroup;
        
        // ✅ NEW: Validate dual bind group readiness
        layer.isDualBindGroupReady = !!(layer.cachedPerFrameBindGroup && layer.cachedPerDataBindGroup);
    }

    chartConfig.renderPlan = newPlan;
    chartConfig.needsPlanRebuild = false; // The plan is now fresh.
  }

  async #coordinatedRender(chartsNeedingRender) {
    
    try {

      await this.#device.queue.onSubmittedWorkDone();

      for (const chartConfig of chartsNeedingRender) {
          console.log(chartConfig)
          if (chartConfig.layers.size > 0) {
              for (const layer of chartConfig.layers.values()) {
                  layer.renderer?.handleScaleOrRangeUpdate();
              }
          }
        }

        await this.#device.queue.onSubmittedWorkDone();

        const commandEncoder = this.#device.createCommandEncoder({ label: 'frame-encoder' });

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
            
            let currentPipeline = null;
            let currentPerFrameBindGroup = null;
            let currentPerDataBindGroup = null;
            
            for (const layer of chartConfig.renderPlan) {
                const renderer = layer.renderer;
                
                // ✅ UPDATED: Check for dual bind group readiness instead of single bindGroup
                // TODO: replace isDualBindGroupReady?
                if (!renderer || !layer.isDualBindGroupReady) {
                    console.debug(`⚠️ Skipping layer ${layer.id} - dual bind groups not ready`);
                    continue;
                }

                const pipelineToUse = layer.cachedPipeline;
                const perFrameBindGroupToUse = layer.cachedPerFrameBindGroup;
                const perDataBindGroupToUse = layer.cachedPerDataBindGroup;

                // Skip this individual layer if its pipeline isn't ready yet.
                if (!pipelineToUse) {
                    console.debug(`⚠️ Skipping layer ${layer.id} - pipeline not ready`);
                    continue;
                }

                // Set pipeline only if it's different from the currently active one.
                if (pipelineToUse !== currentPipeline) {
                    passEncoder.setPipeline(pipelineToUse);
                    currentPipeline = pipelineToUse;
                }
                
                // ✅ UPDATED: Set both bind groups, only if they're different from currently active ones
                if (perFrameBindGroupToUse !== currentPerFrameBindGroup) {
                    passEncoder.setBindGroup(0, perFrameBindGroupToUse);
                    currentPerFrameBindGroup = perFrameBindGroupToUse;
                }
                
                if (perDataBindGroupToUse !== currentPerDataBindGroup) {
                    passEncoder.setBindGroup(1, perDataBindGroupToUse);
                    currentPerDataBindGroup = perDataBindGroupToUse;
                }
                
                layer.draw(passEncoder);
            }
            passEncoder.end();
        }

        this.#device.queue.submit([commandEncoder.finish()]);

        // await this.#device.queue.onSubmittedWorkDone();

        this.#renderCount = (this.#renderCount || 0) + 1;
        
    } catch (error) {
        console.error('Coordinated render failed:', error);
        this.#fallbackRender(chartsNeedingRender);
    }
  }

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
            for (const layer of chartConfig.layers.values()) {
                const renderer = layer.renderer;
                if (renderer?.pipeline && renderer?.perFrameBindGroup && renderer?.perDataBindGroup) {
                    passEncoder.setPipeline(renderer.pipeline);
                    passEncoder.setBindGroup(0, renderer.perFrameBindGroup);
                    passEncoder.setBindGroup(1, renderer.perDataBindGroup);
                    layer.draw(passEncoder);
                }
            }
            passEncoder.end();
            this.#device.queue.submit([commandEncoder.finish()]);
        } catch (error) {
            console.error(`Failed to render chart ${chartConfig.chartId}:`, error);
        }
    }
  }

  async #initWebGPU() {
    // Double-check we're on client-side
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

    // Create shared uniform buffers
    const dprBuffer = device.createBuffer({
      size: 4, // f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#sharedResources.uniformBuffers.set('devicePixelRatio', {
      buffer: dprBuffer,
      refCount: 0, // Will be incremented when used
      createdAt: Date.now()
    });

    // Update initial values
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

  #createRenderPassDescriptor(textureView, canvas, chartId) {
    if (this.#msaaSampleCount > 1) {
      let msaa = this.#msaaCache.get(chartId);

      // Recreate texture if it doesn't exist or if canvas dimensions have changed.
      if (!msaa || 
          msaa.texture.width !== canvas.width ||
          msaa.texture.height !== canvas.height) {
          
          // Destroy the old texture if it exists
          msaa?.texture.destroy();
          
          // Create the new texture
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

          // Store the new texture in our cache
          this.#msaaCache.set(chartId, msaa);
          console.debug(`✨ Created/Resized MSAA resources for chart ${chartId} to ${canvas.width}x${canvas.height}`);
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

  async getOrCreateSharedPipeline(markType, createFn) {
    console.log(`Pipeline request for ${markType}, existing:`, !!this.#sharedResources.pipelines.get(markType));
  
    const existing = this.#sharedResources.pipelines.get(markType);
    
    if (existing) {
      existing.refCount++;
      return existing.pipeline;
    }

    // Check if already creating
    if (this.#creatingPipelines.has(markType)) {
      // Wait for the other creation to complete
      while (this.#creatingPipelines.has(markType)) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // Now get the created pipeline
      const newExisting = this.#sharedResources.pipelines.get(markType);
      newExisting.refCount++;
      console.log(`Pipeline request for ${markType}, was reused after creation:`, !!this.#sharedResources.pipelines.get(markType));
      return newExisting.pipeline;
    }

    // Mark as creating
    this.#creatingPipelines.add(markType);

    console.log(`Creating new pipeline for ${markType}`);
    const pipeline = await createFn();
    
    this.#sharedResources.pipelines.set(markType, {
      pipeline,
      refCount: 1,
      createdAt: Date.now()
    });

    this.#creatingPipelines.delete(markType);

    return pipeline;
  }

  releaseSharedPipeline(markType) {
    const resource = this.#sharedResources.pipelines.get(markType);
    if (!resource) return;

    resource.refCount--;

    if (resource.refCount <= 0) {
      this.#sharedResources.pipelines.delete(markType);
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
    }
  }

  // Legacy getters for backward compatibility
  getSharedPipeline(markType) {
    return this.#sharedResources.pipelines.get(markType)?.pipeline;
  }

  getSharedShaderModule(markType) {
    return this.#sharedResources.shaderModules.get(markType)?.module;
  }

  get device() { return this.#device; }
  get presentationFormat() { return this.#presentationFormat; }
  get msaaSampleCount() { return this.#msaaSampleCount; }
  get isInitialized() { return this.#initialized; }

  destroy() {
    // Stop animation loop
    if (this.#animationRafId !== null) {
      cancelAnimationFrame(this.#animationRafId);
      this.#animationRafId = null;
    }
    
    this.#animationActive = false;
    this.#animatedScales.clear();

    for (const texture of this.#msaaTextures.values()) {
      texture.destroy();
    }
    this.#msaaTextures.clear();

    // Destroy shared resources
    for (const resource of this.#sharedResources.uniformBuffers.values()) {
      if (resource.buffer && !resource.buffer._isDestroyed) { // Safety check
          resource.buffer.destroy();
      }
    }

    if (this.#device) {
      this.#device.destroy();
      this.#device = null;
    }

    this.#sharedResources.uniformBuffers.clear();
    this.#sharedResources.pipelines.clear();
    this.#sharedResources.shaderModules.clear();
    this.#registeredCharts.clear();
    this.#dirtyChartIDs.clear();

    this.#initialized = false;

    console.log('🧹 GPUCoordinator destroyed');
  }
}

export function setGPUCoordinator(config = {}) {
  const coordinator = new GPUCoordinator(config);
  
  // Only initialize on client-side
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



class MinimalPerfLogger {
  constructor(maxSamples = 10000) {
    // Pre-allocate arrays for better performance
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
    this.bufferFullWarned = false; // Track if we've warned
  }
  
  // Inline, minimal frame logging
  log(loopStart, loopEnd, scaleAnimationTime = 0, renderTime = 0, schedulingLag = 0, renderDomain = []) {
    if (this.index >= this.maxSamples) {
      // Warn once when buffer fills
      if (!this.bufferFullWarned) {
        console.warn(`PerformanceLogger: Buffer full (${this.maxSamples} samples). Data collection stopped.`);
        this.bufferFullWarned = true;
      }
      return;
    }
    
    const i = this.index++;
    this.timestamps[i] = loopStart - this.startTime;
    this.cpuTimes[i] = loopEnd - loopStart;  // Total RAF loop duration
    this.scaleAnimationTimes[i] = scaleAnimationTime;
    this.renderTimes[i] = renderTime;
    this.schedulingLags[i] = schedulingLag;
    this.renderDomains[i] = renderDomain;
    
    if (this.lastFrameTime > 0) {
      this.frameDeltas[i] = loopStart - this.lastFrameTime;
    }
    
    this.lastFrameTime = loopStart;
  }
  
  // Export raw arrays for Python analysis
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
    
    return rows; // This creates an array of objects
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