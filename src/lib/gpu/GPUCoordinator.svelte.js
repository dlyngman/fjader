// src/lib/gpu/GPUCoordinator.svelte.js
import { setContext, getContext } from 'svelte';

/**
 * Manages all WebGPU resources, layers, and render scheduling for the dashboard.
 * Implements a "Managed Loop" for high-performance, on-demand rendering and
 * a cached "Render Plan" to keep the per-frame render path extremely lean.
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

  // --- Managed Loop Properties ---
  #loopIsActive = false;
  #rafId = null;
  #dirtyChartIDs = new Set();

  #renderScheduled = false;

  // Configuration
  #msaaSampleCount = 4;

  constructor(config = {}) {
    this.#msaaSampleCount = config.msaaSampleCount ?? 4;
  }

  // ===================================================================
  // == 1. PUBLIC API: Core Lifecycle & Loop Management
  // ===================================================================
  // These are the primary methods external code will call.

  async initialize() {
    if (this.#initialized) return;
    try {
      await this.#initWebGPU();
      await this.#createSharedResources();
      // this.startRenderLoop(); 
      this.#initialized = true;
      console.log('✅ GPUCoordinator initialized successfully');
    } catch (error) {
      console.error('❌ GPUCoordinator initialization failed:', error);
      // this.stopRenderLoop();
      throw error;
    }
  }

  /**
   * The single entry point for triggering a render. This method is designed
   * to be called many times per frame without performance penalty.
   */
  invalidateChart(chartId) {
    if (this.#registeredCharts.has(chartId)) {
      // console.log(`🎯 Adding ${chartId} to dirty set at ${performance.now().toFixed(3)}ms`);
      this.#dirtyChartIDs.add(chartId);

      if (!this.#renderScheduled) {
        this.#renderScheduled = true;
        queueMicrotask(() => {
          console.log(`🚀 Single render for charts:`, Array.from(this.#dirtyChartIDs), 
                    `at ${performance.now().toFixed(3)}ms`);
          this.#renderScheduled = false;
          const chartsToRender = [];
          for (const chartId of this.#dirtyChartIDs) {
              const chart = this.#registeredCharts.get(chartId);
              if (chart?.visible && chart.contextConfigured) {
                  chartsToRender.push(chart);
              }
          }
          this.#coordinatedRender(chartsToRender);
          // this.#coordinatedRender(/* all dirty charts */);
          this.#dirtyChartIDs.clear();
        });
      }

      // queueMicrotask(() => {
      //   console.log(`🎯 Microtask for ${chartId} at ${performance.now().toFixed(3)}ms`);
      // });
    }
  }

  // ===================================================================
  // == 2. PRIVATE: Core Rendering & Scheduling Logic
  // ===================================================================

  startRenderLoop() {
    if (this.#loopIsActive) return;
    this.#loopIsActive = true;
    
    const loop = () => {
      // console.log(this.#dirtyChartIDs.size)
      if (!this.#loopIsActive) { 
        this.#rafId = null; 
        return; 
      }

      // The entire render logic is here.
      if (this.#dirtyChartIDs.size > 0) {
        // Collect chart objects that need rendering for this frame
        const chartsToRender = [];
        for (const chartId of this.#dirtyChartIDs) {
            const chart = this.#registeredCharts.get(chartId);
            if (chart?.visible && chart.contextConfigured) {
                chartsToRender.push(chart);
            }
        }
        // console.log([this.#dirtyChartIDs.size, chartsToRender.length])
        
        // Clear the set for the next frame
        this.#dirtyChartIDs.clear();
        
        if (chartsToRender.length > 0) {
          this.#coordinatedRender(chartsToRender);
        }
      }

      this.#rafId = requestAnimationFrame(loop);
    };
    this.#rafId = requestAnimationFrame(loop);
  }

  stopRenderLoop() {
    this.#loopIsActive = false;
    if (this.#rafId) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
  }

  // ===================================================================
  // == 2. PUBLIC API: Chart & Layer Registration
  // ===================================================================
  // These methods form the public interface for components to register themselves.

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
    // this.#updateRenderQueue(); // This is still useful for z-index sorting.

    return {
        update: (newConfig) => {
          const existingConfig = this.#registeredCharts.get(chartId);
          if (!existingConfig) return;

          // Update only provided values
          for (const [key, value] of Object.entries(newConfig)) {
              if (value !== undefined) {
                  existingConfig[key] = value;
              }
          }

          // Mark context as configured when WebGPUCanvas tells us.
          // This is a critical signal.
          if (newConfig.contextConfigured) {
              existingConfig.contextConfigured = true;
          }

          // If the canvas was resized or moved, we must invalidate to trigger a redraw.
          if (newConfig.canvasResized || newConfig.canvasRepositioned) {
              this.invalidateChart(chartId);
          }
        },

        setVisible: (visible) => {
          const config = this.#registeredCharts.get(chartId);
          if (config && config.visible !== visible) {
              config.visible = visible;
              // Invalidate to ensure the chart is redrawn (or cleared if hidden).
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
      // this.#renderBatches.needsRebuild = true;
      // this.#updateRenderQueue();

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


    // Mark that batches need rebuilding since the layer composition has changed.
    // this.#renderBatches.needsRebuild = true;
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
        // this.#renderBatches.needsRebuild = true;
        this.invalidateChart(chartId); // Invalidate to render the chart without the layer.
    }
  }

  // // ===================================================================
  // // == 3. PUBLIC API: Invalidation
  // // ===================================================================
  // // The single entry point for triggering a render.
  // invalidateChart(chartId) {
  //   if (this.#registeredCharts.has(chartId)) {
  //     this.#dirtyChartIDs.add(chartId);
  //     // If the loop is sleeping, we need to schedule a single frame to render this change.
  //     if (!this.#loopIsActive) {
  //       console.log('loop sleeping, single frame requested')
  //       this.#requestSingleFrame();
  //     }
  //   }
  // }

  // ===================================================================
  // == 4. PRIVATE: Core Rendering & Scheduling Logic
  // ===================================================================
  // These are the internal "engine" methods that drive the rendering process.

  // #setupContinuousRenderLoop() {
  //   const loop = () => {
  //     if (!this.#loopIsActive) {
  //       this.#rafId = null; // Loop has been requested to stop.
  //       return;
  //     }
  //     this.#render();
  //     this.#rafId = requestAnimationFrame(loop);
  //   };
  //   this.#rafId = requestAnimationFrame(loop);
  // }

  // #requestSingleFrame() {
  //   // Only schedule a one-off frame if the main loop isn't running and a frame isn't already requested.
  //   if (this.#loopIsActive || this.#rafId) return;
  //   this.#rafId = requestAnimationFrame(() => {
  //     this.#render();
  //     this.#rafId = null; // This was a one-off frame.
  //   });
  // }

  // #render() {
  //   if (this.#dirtyChartIDs.size === 0) return;
  //   try {
  //       this.#chartsToRenderThisFrame.length = 0;
  //       for (const chartId of this.#dirtyChartIDs) {
  //           const chart = this.#registeredCharts.get(chartId);
  //           if (chart?.visible && chart.contextConfigured) {
  //               this.#chartsToRenderThisFrame.push(chart);
  //           }
  //       }        
  //       this.#dirtyChartIDs.clear();
  //       if (this.#chartsToRenderThisFrame.length > 0) {
  //         this.#coordinatedRender(this.#chartsToRenderThisFrame);
  //       }
  //   } catch (error) {
  //     console.error('GPUCoordinator render error:', error);
  //   }
  // }

  /**
   * Builds a sorted and batched "Render Plan" for a chart.
   * This is run only when a chart's layer structure changes, not on every frame.
   */
  #buildRenderPlanForChart(chartConfig) {
    console.debug(`🛠️ Rebuilding render plan for chart: ${chartConfig.chartId}`);
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

    // Enrich the plan with cached pipeline references to avoid lookups in the hot loop.
    for (const layer of newPlan) {
        layer.cachedPipeline = layer.renderer?.pipeline;
    }

    chartConfig.renderPlan = newPlan;
    chartConfig.needsPlanRebuild = false; // The plan is now fresh.
  }

  /**
   * The main render function. It is designed to be lean, performing minimal work
   * by iterating over a pre-computed "Render Plan".
   */
  #coordinatedRender(chartsNeedingRender) {
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
            for (const layer of chartConfig.renderPlan) {
                const renderer = layer.renderer;
                if (renderer?.bindGroup) {
                    const pipelineToUse = layer.cachedPipeline;

                    // Skip this individual layer if its pipeline isn't ready yet.
                    if (!pipelineToUse) continue;

                    // Set pipeline only if it's different from the currently active one.
                    if (pipelineToUse !== currentPipeline) {
                        passEncoder.setPipeline(pipelineToUse);
                        currentPipeline = pipelineToUse;
                    }
                    
                    passEncoder.setBindGroup(0, renderer.bindGroup);
                    layer.draw(passEncoder);
                }
            }
            passEncoder.end();
        }

        this.#device.queue.submit([commandEncoder.finish()]);
        
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
                if (renderer?.pipeline && renderer?.bindGroup) {
                    passEncoder.setPipeline(renderer.pipeline);
                    passEncoder.setBindGroup(0, renderer.bindGroup);
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

  // ===================================================================
  // == 5. PRIVATE: WebGPU & Resource Initialization
  // ===================================================================
  // Low-level setup and helper methods.

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

  // ===================================================================
  // == 6. PUBLIC API: Resource Sharing
  // ===================================================================
  // The public interface for renderers to get shared GPU resources.

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

  // ===================================================================
  // == 7. PUBLIC API: Getters
  // ===================================================================
  // Public accessors for state and development tools.

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

  // ===== CLEANUP =====

  destroy() {
    this.stopRenderLoop();
    if (this.#rafId) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#loopIsActive = false;
    // this.#activeLoopRequesters.clear();

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

// ===================================================================
// == CONTEXT FUNCTIONS
// ===================================================================

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