// src/lib/gpu/GPUCoordinator.svelte.js
import { setContext, getContext } from 'svelte';

/**
 * Manages all WebGPU resources, layers, and render scheduling for the dashboard.
 * Implements a "Managed Loop" for high-performance, on-demand rendering.
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
  #renderQueue = [];

  // Map for caching MSAA textures
  #msaaTextures = new Map();

  // --- Managed Loop Properties ---
  #loopIsActive = false;
  #activeLoopRequesters = new Set(); // Stores unique IDs of components needing the loop
  #rafId = null;
  #dirtyChartIDs = new Set();

  // Enhanced render batching
  #renderBatches = $state({
    byMarkType: new Map(), // 'dots' -> [chart1, chart2, ...]
    byZIndex: new Map(),   // 0 -> [charts...], 1 -> [charts...]
    needsRebuild: true
  });

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
    if (this.#initialized) {
      console.warn('GPUCoordinator already initialized');
      return;
    }

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

  // ===== LOOP MANAGEMENT API =====
  requestActiveLoop(requesterId) {
    console.log('requesting active loop')
    if (!requesterId) return;
    this.#activeLoopRequesters.add(requesterId);
    if (!this.#loopIsActive && this.#activeLoopRequesters.size > 0) {
      this.#loopIsActive = true;
      this.#setupContinuousRenderLoop();
    }
  }

  releaseActiveLoop(requesterId) {
    console.log('releasing active loop')
    this.#activeLoopRequesters.delete(requesterId);
    if (this.#loopIsActive && this.#activeLoopRequesters.size === 0) {
      this.#loopIsActive = false;
      // The loop will stop itself on the next frame check.
    }
  }

  // ===================================================================
  // == 2. PUBLIC API: Chart & Layer Registration
  // ===================================================================
  // These methods form the public interface for components to register themselves.

  registerChart(chartId, canvas, config) {
    const { zIndex = 0 } = config;

    if (this.#registeredCharts.has(chartId)) {
        console.warn(`Chart ${chartId} already registered, updating config`);
    }

    const chartConfig = {
        chartId,
        canvas,
        zIndex,
        visible: true,
        context: canvas.getContext('webgpu'),
        contextConfigured: false,
        layers: new Map()
    };

    this.#registeredCharts.set(chartId, chartConfig);
    this.#updateRenderQueue(); // This is still useful for z-index sorting.

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
      this.#renderBatches.needsRebuild = true;
      this.#updateRenderQueue();

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
    chart.layers.set(layerId, { ...layerConfig, id: layerId });

    // Mark that batches need rebuilding since the layer composition has changed.
    this.#renderBatches.needsRebuild = true;
    this.invalidateChart(chartId); // Invalidate the chart to ensure the new layer is drawn.

    return {
        remove: () => this.unregisterLayer(chartId, layerId)
    };
  }

  unregisterLayer(chartId, layerId) {
    const chart = this.#registeredCharts.get(chartId);
    if (chart && chart.layers.has(layerId)) {
        chart.layers.delete(layerId);
        this.#renderBatches.needsRebuild = true;
        this.invalidateChart(chartId); // Invalidate to render the chart without the layer.
    }
  }

  // ===================================================================
  // == 3. PUBLIC API: Invalidation
  // ===================================================================
  // The single entry point for triggering a render.
  invalidateChart(chartId) {
    if (this.#registeredCharts.has(chartId)) {
      this.#dirtyChartIDs.add(chartId);
      // If the loop is sleeping, we need to schedule a single frame to render this change.
      if (!this.#loopIsActive) {
        console.log('loop sleeping, single frame requested')
        this.#requestSingleFrame();
      }
    }
  }

  // ===================================================================
  // == 4. PRIVATE: Core Rendering & Scheduling Logic
  // ===================================================================
  // These are the internal "engine" methods that drive the rendering process.

  #setupContinuousRenderLoop() {
    const loop = () => {
      if (!this.#loopIsActive) {
        this.#rafId = null; // Loop has been requested to stop.
        return;
      }
      this.#render();
      this.#rafId = requestAnimationFrame(loop);
    };
    this.#rafId = requestAnimationFrame(loop);
  }

  #requestSingleFrame() {
    // Only schedule a one-off frame if the main loop isn't running and a frame isn't already requested.
    if (this.#loopIsActive || this.#rafId) return;
    this.#rafId = requestAnimationFrame(() => {
      this.#render();
      this.#rafId = null; // This was a one-off frame.
    });
  }

  #render() {
    if (this.#dirtyChartIDs.size === 0) {
      return; // Nothing to do this frame.
    }

    try {
        const chartsNeedingRender = [];
        for (const chartId of this.#dirtyChartIDs) {
            const chart = this.#registeredCharts.get(chartId);
            if (chart?.visible && chart.contextConfigured) {
                chartsNeedingRender.push(chart);
            }
        }        
        this.#dirtyChartIDs.clear();
        if (chartsNeedingRender.length > 0) {
          this.#coordinatedRender(chartsNeedingRender);
        }
    } catch (error) {
      console.error('GPUCoordinator render error:', error);
    }
  }

  #coordinatedRender(chartsNeedingRender) {
    if (this.#renderBatches.needsRebuild) {
        this.#rebuildRenderBatches();
    }

    try {
        // We need a map to store the render pass encoders for each dirty chart.
        // Map<chartId, GPURenderPassEncoder>
        const passEncoders = new Map();
        const commandBuffers = [];

        // A helper to get or create a pass encoder for a chart.
        const getPassEncoder = (chartConfig) => {
            if (passEncoders.has(chartConfig.chartId)) {
                return passEncoders.get(chartConfig.chartId);
            }

            const commandEncoder = this.#device.createCommandEncoder({ label: `${chartConfig.chartId}-encoder` });
            const context = chartConfig.context;
            const textureView = context.getCurrentTexture().createView();
            const renderPassDescriptor = this.#createRenderPassDescriptor(textureView, chartConfig.canvas, chartConfig.chartId);
            const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
            
            // Store everything we need to finish it later.
            passEncoders.set(chartConfig.chartId, { passEncoder, commandEncoder });
            return { passEncoder, commandEncoder };
        };
        
        // Iterate through the batches by MARK TYPE for efficiency.
        for (const [markType, layersInBatch] of this.#renderBatches.byMarkType) {
            // Get the shared pipeline for this mark type ONCE.
            const sharedPipeline = this.getSharedPipeline(markType);
            if (!sharedPipeline) continue;

            // Set this pipeline ONCE for all subsequent draw calls of this type.
            // NOTE: This is the key optimization, but WebGPU requires setPipeline
            // to be called within a render pass. So we must call it for each pass.
            // The REAL optimization is that we don't have to LOOK UP the pipeline repeatedly.
            // The logic below still yields the most efficient command structure.

            for (const layer of layersInBatch) {
                const chartConfig = layer.chart;

                // IMPORTANT: Only draw this layer if its parent chart is in the dirty list.
                if (!chartsNeedingRender.includes(chartConfig)) {
                    continue;
                }

                // Get or create the render pass for this layer's chart.
                const { passEncoder } = getPassEncoder(chartConfig);
                
                const renderer = layer.renderer;
                if (renderer?.pipeline && renderer?.bindGroup) {
                    // The primary optimization: we set the pipeline once per mark type *per render pass*.
                    passEncoder.setPipeline(renderer.pipeline);
                    passEncoder.setBindGroup(0, renderer.bindGroup);
                    layer.draw(passEncoder);
                }
            }
        }

        // Now, end all the render passes and finish the command buffers.
        for (const { passEncoder, commandEncoder } of passEncoders.values()) {
            passEncoder.end();
            commandBuffers.push(commandEncoder.finish());
        }

        if (commandBuffers.length > 0) {
            this.#device.queue.submit(commandBuffers);
        }
        
        chartsNeedingRender.forEach(chart => chart.needsRedraw = false);

    } catch (error) {
        console.error('Batched coordinated render failed:', error);
        // In a real app, you might want a fallback to the simpler render loop here.
    }
  }

  #rebuildRenderBatches() {
    console.debug(`🔄 Rebuilding render batches...`);
    this.#renderBatches.byMarkType.clear();
    this.#renderBatches.byZIndex.clear(); // Keep this for future z-index work

    for (const chartConfig of this.#registeredCharts.values()) {
        if (chartConfig.layers && chartConfig.layers.size > 0) {
            for (const layerConfig of chartConfig.layers.values()) {
                const markType = layerConfig.markType || 'unknown';

                if (!this.#renderBatches.byMarkType.has(markType)) {
                    this.#renderBatches.byMarkType.set(markType, []);
                }
                
                this.#renderBatches.byMarkType.get(markType).push({
                    ...layerConfig,
                    chart: chartConfig 
                });
            }
        }
    }
    this.#renderBatches.needsRebuild = false;
    console.debug(`✅ Render batches rebuilt.`);
  }

  #updateRenderQueue() {
    this.#renderQueue = Array.from(this.#registeredCharts.values())
      .filter(config => config.visible)
      .sort((a, b) => a.zIndex - b.zIndex);
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

    const adapter = await navigator.gpu.requestAdapter();
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
    if (this.#rafId) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#loopIsActive = false;
    this.#activeLoopRequesters.clear();

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
    this.#renderQueue = [];
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