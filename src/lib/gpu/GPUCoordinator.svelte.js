import { setContext, getContext } from 'svelte';

/**
 * Manages all WebGPU resources, layers, and render scheduling for the dashboard.
 * Implements a "Managed Loop" for high-performance, on-demand rendering and
 * a cached "Render Plan" to keep the per-frame render path extremely lean.
 * 
 * ✅ UPDATED: Now supports dual bind group architecture for optimal performance
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
  #msaaTextures = new Map();

  #dirtyChartIDs = new Set();
  #renderScheduled = false;

  // Configuration
  #msaaSampleCount = 4;
  lastRender;

  #frameHistory = [];
  #renderCount = 0;

  constructor(config = {}) {
    this.#msaaSampleCount = config.msaaSampleCount ?? 4;
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

  /**
   * The single entry point for triggering a render. This method is designed
   * to be called many times per frame without performance penalty.
   */
  invalidateChart(chartId) {
    const timestamp = performance.now();
    // console.log(`🔄 invalidateChart(${chartId}) called at ${timestamp.toFixed(2)}ms`);

    if (this.#registeredCharts.has(chartId)) {
      this.#dirtyChartIDs.add(chartId);

      if (!this.#renderScheduled) {
        this.#renderScheduled = true;
        // console.log(`⏰ Scheduling microtask at ${timestamp.toFixed(2)}ms`);

        // queueMicrotask(() => {
        requestAnimationFrame(() => { 
          const microtaskTime = performance.now();
          // console.log(`🚀 Microtask executing at ${microtaskTime.toFixed(2)}ms (delay: ${(microtaskTime - timestamp).toFixed(2)}ms)`);

          this.#renderScheduled = false;
          const chartsToRender = [];
          for (const chartId of this.#dirtyChartIDs) {
              const chart = this.#registeredCharts.get(chartId);
              if (chart?.visible && chart.contextConfigured) {
                  chartsToRender.push(chart);
              }
          }
          this.#coordinatedRender(chartsToRender);
          this.#dirtyChartIDs.clear();
        });
      } else {
        console.log(`⏭️ Render already scheduled at ${timestamp.toFixed(2)}ms`);
      }
    }
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
      const msaaTexture = this.#msaaTextures.get(chartId);
      if (msaaTexture) {
        msaaTexture.destroy();
        this.#msaaTextures.delete(chartId);
        console.debug(`🗑️ Destroyed cached MSAA texture for chart: ${chartId}`);
      }

      console.log(`📊 Unregistered chart: ${chartId}`);
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

  /**
   * The main render function. It is designed to be lean, performing minimal work
   * by iterating over a pre-computed "Render Plan".
   * 
   * ✅ UPDATED: Now supports dual bind group architecture for optimal performance
   */
  #coordinatedRender(chartsNeedingRender) {
    
    const startTime = performance.now();
  
    // Track frame intervals
    if (this.lastRender) {
      const frameInterval = startTime - this.lastRender;
      // this.#trackFrameTiming(frameInterval);
    }
    
    // console.log(`🎨 Render #${this.#renderCount || 0} at ${startTime.toFixed(2)}ms (${chartsNeedingRender.length} charts)`);
  
    try {

        for (const chartConfig of chartsNeedingRender) {
          if (chartConfig.layers.size > 0) {
              for (const layer of chartConfig.layers.values()) {
                  layer.renderer?.handleScaleOrRangeUpdate();
              }
          }
        }

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
        const endTime = performance.now();
        const renderDuration = endTime - startTime;

        // // Enhanced frame timing analysis
        // if (this.lastRender) {
        //   const frameInterval = startTime - this.lastRender;
        //   const fps = 1000 / frameInterval;
          
        //   console.log(`⏱️ Frame interval: ${frameInterval.toFixed(1)}ms (${fps.toFixed(1)}fps) | Render duration: ${renderDuration.toFixed(2)}ms`);
          
        //   // Flag irregular timing
        //   if (Math.abs(frameInterval - 8.33) > 2 && Math.abs(frameInterval - 16.67) > 2) {
        //     console.warn(`🔥 Irregular frame timing: ${frameInterval.toFixed(1)}ms (expected ~8.3ms or ~16.7ms)`);
        //   }
        // }
          
        // console.log(`✅ Render #${this.#renderCount || 0} completed at ${endTime.toFixed(2)}ms (duration: ${renderDuration.toFixed(2)}ms)`);

        // if (renderDuration > 8) {
        //   console.warn(`🐌 Slow render: ${renderDuration.toFixed(2)}ms (target: <8ms for 120fps)`);
        // }
        
        // Update tracking variables
        this.lastRender = startTime; // Use start time for interval calculation
        this.#renderCount = (this.#renderCount || 0) + 1;
        
    } catch (error) {
        console.error('Coordinated render failed:', error);
        this.#fallbackRender(chartsNeedingRender);
    }
  }

  #trackFrameTiming(interval) {
    this.#frameHistory.push(interval);
    
    // Keep last 30 frames for analysis
    if (this.#frameHistory.length > 30) {
      this.#frameHistory.shift();
    }
    
    // Every 10 frames, analyze the pattern
    if (this.#frameHistory.length >= 10 && this.#frameHistory.length % 10 === 0) {
      const avg = this.#frameHistory.reduce((a, b) => a + b) / this.#frameHistory.length;
      const avgFps = 1000 / avg;
      const jitter = Math.max(...this.#frameHistory) - Math.min(...this.#frameHistory);
      
      console.log(`📊 Frame Analysis (last ${this.#frameHistory.length}): Avg ${avgFps.toFixed(1)}fps, Jitter ${jitter.toFixed(1)}ms`);
      
      // Detect specific patterns
      const consistent60fps = this.#frameHistory.every(t => Math.abs(t - 16.67) < 2);
      const consistent120fps = this.#frameHistory.every(t => Math.abs(t - 8.33) < 2);
      
      if (consistent60fps) {
        console.info(`🔒 Locked to 60fps - browser/VSync limiting detected`);
      } else if (consistent120fps) {
        console.info(`🚀 Smooth 120fps - timing working correctly`);
      } else if (jitter > 5) {
        console.warn(`⚡ High frame jitter: ${jitter.toFixed(1)}ms - RAF/microtask mismatch likely`);
      }
    }
  }

  // ✅ UPDATED: Fallback render also supports dual bind groups
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
      let multisampleTexture = this.#msaaTextures.get(chartId);

      // Recreate texture if it doesn't exist or if canvas dimensions have changed.
      if (!multisampleTexture || 
          multisampleTexture.width !== canvas.width ||
          multisampleTexture.height !== canvas.height) {
          
          // Destroy the old texture if it exists
          multisampleTexture?.destroy();
          
          // Create the new texture
          multisampleTexture = this.#device.createTexture({
              size: { width: canvas.width, height: canvas.height },
              sampleCount: this.#msaaSampleCount,
              format: this.#presentationFormat,
              usage: GPUTextureUsage.RENDER_ATTACHMENT
          });

          // Store the new texture in our cache
          this.#msaaTextures.set(chartId, multisampleTexture);
          console.debug(`✨ Created/Resized MSAA texture for chart ${chartId} to ${canvas.width}x${canvas.height}`);
      }

      return {
        colorAttachments: [{
          // Use the cached texture's view
          view: multisampleTexture.createView(),
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
    const existing = this.#sharedResources.pipelines.get(markType);
    
    if (existing) {
      existing.refCount++;
      return existing.pipeline;
    }

    const pipeline = await createFn();
    
    this.#sharedResources.pipelines.set(markType, {
      pipeline,
      refCount: 1,
      createdAt: Date.now()
    });

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