// src/lib/gpu/GPUCoordinator.svelte.js
import { setContext, getContext } from 'svelte';

/**
 * GPU Coordination Debugger for development and monitoring
 */
class GPUCoordinationDebugger {
  constructor(coordinator) {
    this.coordinator = coordinator;
    this.renderStats = {
      frameCount: 0,
      totalRenderTime: 0,
      averageRenderTime: 0,
      lastFrameTime: 0,
      renderErrors: []
    };
    this.renderStartTime = null;
    
    // Only enable in development
    if (typeof window !== 'undefined') {
      window.__DEBUG_GPU_COORDINATOR = coordinator;
      window.__DEBUG_GPU_DEBUGGER = this;
    }
  }

  startRenderTiming() {
    this.renderStartTime = performance.now();
  }

  endRenderTiming() {
    if (!this.renderStartTime) return;
    
    const renderTime = performance.now() - this.renderStartTime;
    this.renderStats.frameCount++;
    this.renderStats.totalRenderTime += renderTime;
    this.renderStats.lastFrameTime = renderTime;
    this.renderStats.averageRenderTime = this.renderStats.totalRenderTime / this.renderStats.frameCount;
    
    // Warn about slow frames
    if (renderTime > 16.67) { // > 60fps threshold
      console.warn(`🐌 Slow render frame: ${renderTime.toFixed(2)}ms`);
    }
    
    this.renderStartTime = null;
  }

  analyzeResourceUsage() {
    const stats = this.coordinator.getPerformanceStats();
    const analysis = {
      efficiency: 'unknown',
      recommendations: [],
      warnings: []
    };

    // Analyze pipeline sharing efficiency
    const totalPipelines = stats.resourceStats.pipelines.length;
    const averageRefs = totalPipelines > 0 
      ? stats.resourceStats.pipelines.reduce((sum, p) => sum + p.refCount, 0) / totalPipelines
      : 0;

    if (averageRefs < 2) {
      analysis.warnings.push('Low pipeline sharing - consider consolidating mark types');
      analysis.efficiency = 'poor';
    } else if (averageRefs > 5) {
      analysis.efficiency = 'excellent';
    } else {
      analysis.efficiency = 'good';
    }

    // Check for resource leaks
    const oldResources = stats.resourceStats.pipelines.filter(p => p.ageMs > 300000); // 5 minutes
    if (oldResources.length > 0) {
      analysis.warnings.push(`${oldResources.length} old resources detected - potential memory leak`);
    }

    // Performance recommendations
    if (this.renderStats.averageRenderTime > 8) {
      analysis.recommendations.push('Consider reducing mark complexity or data volume');
    }

    if (stats.renderBatches.markTypeBatches > 5) {
      analysis.recommendations.push('Too many mark types - consider consolidation');
    }

    return analysis;
  }

  logCoordinationState() {
    const stats = this.coordinator.getPerformanceStats();
    const analysis = this.analyzeResourceUsage();
    
    console.group('🔍 GPU Coordination Debug Report');
    
    console.log('📊 Performance Stats:', {
      ...this.renderStats,
      efficiency: analysis.efficiency
    });
    
    console.log('🔧 Resource Usage:', stats.resourceStats);
    console.log('🎨 Render Batches:', stats.renderBatches);
    
    if (analysis.warnings.length > 0) {
      console.warn('⚠️ Warnings:', analysis.warnings);
    }
    
    if (analysis.recommendations.length > 0) {
      console.info('💡 Recommendations:', analysis.recommendations);
    }
    
    console.groupEnd();
  }

  recordRenderError(error, context) {
    const errorRecord = {
      timestamp: Date.now(),
      error: error.message,
      context,
      stack: error.stack
    };
    
    this.renderStats.renderErrors.push(errorRecord);
    
    // Keep only last 50 errors
    if (this.renderStats.renderErrors.length > 50) {
      this.renderStats.renderErrors.shift();
    }
  }

  debugChart(chartId) {
    const chartConfig = this.coordinator._registeredCharts.get(chartId);
    if (!chartConfig) {
      console.error(`Chart ${chartId} not found`);
      return;
    }

    console.group(`🎯 Chart Debug: ${chartId}`);
    console.log('Chart Config:', {
      visible: chartConfig.visible,
      zIndex: chartConfig.zIndex,
      markTypes: chartConfig.markTypes,
      viewport: chartConfig.viewport,
      contextConfigured: chartConfig.contextConfigured
    });
    
    if (chartConfig.canvas) {
      console.log('Canvas State:', {
        width: chartConfig.canvas.width,
        height: chartConfig.canvas.height,
        style: chartConfig.canvas.style.cssText
      });
    }
    
    console.groupEnd();
  }
}

/**
 * Enhanced GPU Coordinator with resource sharing, batching, and debugging
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
  #renderQueue = $state([]);
  #needsRedraw = $state(false);
  #rafId = null;
  #lastRenderTime = 0;

  // Enhanced render batching
  #renderBatches = $state({
    byMarkType: new Map(), // 'dots' -> [chart1, chart2, ...]
    byZIndex: new Map(),   // 0 -> [charts...], 1 -> [charts...]
    needsRebuild: true
  });

  // Configuration
  #msaaSampleCount = 4;
  #enableDebugging = true;

  constructor(config = {}) {
    this.#msaaSampleCount = config.msaaSampleCount ?? 4;
    this.#enableDebugging = config.enableDebugging !== false;
    
    // Initialize debugging
    if (this.#enableDebugging) {
      this.debugger = new GPUCoordinationDebugger(this);
    }
  }

  // ===== INITIALIZATION =====

  async initialize() {
    if (this.#initialized) {
      console.warn('GPUCoordinator already initialized');
      return;
    }

    try {
      await this.#initWebGPU();
      await this.#createSharedResources();
      this.#initialized = true;
      this.#setupRenderLoop();
      console.log('✅ GPUCoordinator initialized successfully');
    } catch (error) {
      console.error('❌ GPUCoordinator initialization failed:', error);
      this.debugger?.recordRenderError(error, 'initialization');
      throw error;
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

  // ===== ENHANCED RESOURCE SHARING =====

  async getOrCreateSharedPipeline(markType, createFn) {
    const existing = this.#sharedResources.pipelines.get(markType);
    
    if (existing) {
      existing.refCount++;
      console.log(`♻️ Reusing shared pipeline for ${markType} (refs: ${existing.refCount})`);
      return existing.pipeline;
    }

    console.log(`🆕 Creating new shared pipeline for ${markType}`);
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
    console.log(`🔄 Released shared pipeline for ${markType} (refs: ${resource.refCount})`);

    if (resource.refCount <= 0) {
      console.log(`🗑️ Destroying unused shared pipeline for ${markType}`);
      this.#sharedResources.pipelines.delete(markType);
    }
  }

  async getOrCreateSharedShader(markType, shaderCode) {
    const existing = this.#sharedResources.shaderModules.get(markType);
    
    if (existing) {
      existing.refCount++;
      console.log(`♻️ Reusing shared shader for ${markType} (refs: ${existing.refCount})`);
      return existing.module;
    }

    console.log(`🆕 Creating new shared shader for ${markType}`);
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
    console.log(`🔄 Released shared shader for ${markType} (refs: ${resource.refCount})`);

    if (resource.refCount <= 0) {
      console.log(`🗑️ Destroying unused shared shader for ${markType}`);
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

  setSharedPipeline(markType, pipeline) {
    this.#sharedResources.pipelines.set(markType, {
      pipeline,
      refCount: 1,
      createdAt: Date.now()
    });
  }

  getSharedShaderModule(markType) {
    return this.#sharedResources.shaderModules.get(markType)?.module;
  }

  setSharedShaderModule(markType, shaderModule) {
    this.#sharedResources.shaderModules.set(markType, {
      module: shaderModule,
      refCount: 1,
      createdAt: Date.now()
    });
  }

  // ===== CHART REGISTRATION =====

  registerChart(chartId, canvas, config) {
    const {
      drawFunction,
      zIndex = 0,
      markTypes = [],
    } = config;

    if (this.#registeredCharts.has(chartId)) {
      console.warn(`Chart ${chartId} already registered, updating config`);
    }

    // Calculate viewport from canvas position
    const rect = canvas.getBoundingClientRect();
    const viewport = {
      x: rect.left,
      y: rect.top,
      width: canvas.width,
      height: canvas.height
    };

    const chartConfig = {
      chartId,
      canvas,
      viewport,
      drawFunction,
      zIndex,
      markTypes,
      visible: true,
      needsRedraw: true,
      context: canvas.getContext('webgpu'),
      contextConfigured: false
    };

    this.#registeredCharts.set(chartId, chartConfig);
    this.#renderBatches.needsRebuild = true; // Mark for rebuild
    this.#updateRenderQueue();

    console.log(`📊 Registered chart: ${chartId} with marks: [${markTypes.join(', ')}]`);

    // Return control object for the chart
    return {
      update: (newConfig) => {
        const existingConfig = this.#registeredCharts.get(chartId);
        if (existingConfig) {
          Object.assign(existingConfig, newConfig);
          
          // Update viewport if canvas size changed
          if (newConfig.canvasResized) {
            const rect = existingConfig.canvas.getBoundingClientRect();
            existingConfig.viewport = {
              x: rect.left,
              y: rect.top,
              width: existingConfig.canvas.width,
              height: existingConfig.canvas.height
            };
          }

          // Mark context as configured when WebGPUCanvas tells us
          if (newConfig.contextConfigured) {
            existingConfig.contextConfigured = true;
          }

          // Check if mark types changed (affects batching)
          if (newConfig.markTypes) {
            this.#renderBatches.needsRebuild = true;
          }
          
          this.#updateRenderQueue();
          this.requestRedraw();
        }
      },
      
      setVisible: (visible) => {
        const config = this.#registeredCharts.get(chartId);
        if (config) {
          config.visible = visible;
          this.requestRedraw();
        }
      },

      invalidate: () => {
        const config = this.#registeredCharts.get(chartId);
        if (config) {
          config.needsRedraw = true;
          this.requestRedraw();
        }
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
      this.requestRedraw();
      console.log(`📊 Unregistered chart: ${chartId}`);
    }
  }

  #updateRenderQueue() {
    this.#renderQueue = Array.from(this.#registeredCharts.values())
      .filter(config => config.visible)
      .sort((a, b) => a.zIndex - b.zIndex);
  }

  // ===== ENHANCED RENDERING WITH BATCHING =====

  #setupRenderLoop() {
    this.requestRedraw();
  }

  requestRedraw() {
    if (this.#rafId !== null || !this.#initialized) return;
    
    this.#needsRedraw = true;
    this.#rafId = requestAnimationFrame(() => this.#render());
  }

  #render() {
    if (!this.#device || !this.#needsRedraw) {
      this.#rafId = null;
      return;
    }

    try {
      this.debugger?.startRenderTiming();

      // Use live data instead of cached render queue
      const liveRenderQueue = Array.from(this.#registeredCharts.values())
        .filter(config => config.visible)
        .sort((a, b) => a.zIndex - b.zIndex);
      
      // Only include charts with properly configured contexts
      const chartsNeedingRender = liveRenderQueue.filter(chart => 
        chart.visible && 
        chart.needsRedraw && 
        chart.drawFunction &&
        chart.contextConfigured
      );

      if (chartsNeedingRender.length === 0) {
        this.#needsRedraw = false;
        this.#rafId = null;
        return;
      }

      // Enhanced coordinated rendering with batching
      this.#coordinatedRender(chartsNeedingRender);
      this.#lastRenderTime = Date.now();

      this.debugger?.endRenderTiming();

    } catch (error) {
      console.error('GPUCoordinator render error:', error);
      this.debugger?.recordRenderError(error, 'main-render-loop');
    } finally {
      this.#needsRedraw = false;
      this.#rafId = null;
    }
  }

  #coordinatedRender(charts) {
    // Rebuild batches if needed
    if (this.#renderBatches.needsRebuild) {
      this.#rebuildRenderBatches(charts);
    }

    try {
      // Use mark-type batching for maximum efficiency
      this.#renderByMarkTypeBatches(charts);
    } catch (error) {
      console.error('Coordinated render failed:', error);
      this.debugger?.recordRenderError(error, 'coordinated-render');
      // Fallback to individual chart rendering
      this.#fallbackIndividualRender(charts);
    }
  }

  #renderByMarkTypeBatches(charts) {
    const commandEncoders = [];
    
    // Process each mark type batch
    for (const [markType, chartsForType] of this.#renderBatches.byMarkType) {
      if (chartsForType.length === 0) continue;
      
      console.debug(`🎨 Batch rendering ${chartsForType.length} charts with ${markType} marks`);
      
      // Get shared pipeline for this mark type
      const sharedResource = this.#sharedResources.pipelines.get(markType);
      
      for (const chartConfig of chartsForType) {
        if (!charts.includes(chartConfig)) continue; // Skip if not in current render list
        
        try {
          const context = chartConfig.context;
          if (!context) continue;
          
          const textureView = context.getCurrentTexture().createView();
          const commandEncoder = this.#device.createCommandEncoder({
            label: `${chartConfig.chartId}-${markType}-encoder`
          });
          
          const renderPassDescriptor = this.#createRenderPassDescriptor(textureView, chartConfig.canvas);
          const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
          
          // Pass enhanced shared resources for efficiency
          chartConfig.drawFunction(passEncoder, {
            pipelines: this.#sharedResources.pipelines,
            uniformBuffers: this.#sharedResources.uniformBuffers,
            shaderModules: this.#sharedResources.shaderModules,
            currentMarkType: markType,
            sharedPipeline: sharedResource?.pipeline
          });
          
          passEncoder.end();
          commandEncoders.push(commandEncoder.finish());
          chartConfig.needsRedraw = false;
          
        } catch (error) {
          console.error(`❌ Batch render failed for chart ${chartConfig.chartId}:`, error);
          this.debugger?.recordRenderError(error, `batch-render-${chartConfig.chartId}`);
        }
      }
    }

    // Submit all commands together for maximum GPU efficiency
    if (commandEncoders.length > 0) {
      this.#device.queue.submit(commandEncoders);
      console.debug(`✅ Submitted ${commandEncoders.length} render commands in batch`);
    }
  }

  #rebuildRenderBatches(charts) {
    console.debug(`🔄 Rebuilding render batches for ${charts.length} charts`);
    
    // Clear existing batches
    this.#renderBatches.byMarkType.clear();
    this.#renderBatches.byZIndex.clear();
    
    for (const chart of charts) {
      // Group by mark types
      for (const markType of chart.markTypes || ['unknown']) {
        if (!this.#renderBatches.byMarkType.has(markType)) {
          this.#renderBatches.byMarkType.set(markType, []);
        }
        this.#renderBatches.byMarkType.get(markType).push(chart);
      }
      
      // Group by z-index
      const zIndex = chart.zIndex || 0;
      if (!this.#renderBatches.byZIndex.has(zIndex)) {
        this.#renderBatches.byZIndex.set(zIndex, []);
      }
      this.#renderBatches.byZIndex.get(zIndex).push(chart);
    }
    
    this.#renderBatches.needsRebuild = false;
    
    console.debug(`✅ Render batches rebuilt:`, {
      markTypes: this.#renderBatches.byMarkType.size,
      zLevels: this.#renderBatches.byZIndex.size
    });
  }

  #fallbackIndividualRender(charts) {
    console.warn(`⚠️ Falling back to individual chart rendering`);
    
    for (const chartConfig of charts) {
      try {
        const context = chartConfig.context;
        if (!context) continue;
        
        const textureView = context.getCurrentTexture().createView();
        const commandEncoder = this.#device.createCommandEncoder();
        const renderPassDescriptor = this.#createRenderPassDescriptor(textureView, chartConfig.canvas);
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

        chartConfig.drawFunction(passEncoder, {
          pipelines: this.#sharedResources.pipelines,
          uniformBuffers: this.#sharedResources.uniformBuffers,
          shaderModules: this.#sharedResources.shaderModules
        });
        
        passEncoder.end();
        this.#device.queue.submit([commandEncoder.finish()]);
        chartConfig.needsRedraw = false;
        
      } catch (error) {
        console.error(`❌ Individual render failed for ${chartConfig.chartId}:`, error);
        this.debugger?.recordRenderError(error, `individual-render-${chartConfig.chartId}`);
      }
    }
  }

  #createRenderPassDescriptor(textureView, canvas) {
    if (this.#msaaSampleCount > 1) {
      const multisampleTexture = this.#device.createTexture({
        size: {
          width: canvas.width,
          height: canvas.height
        },
        sampleCount: this.#msaaSampleCount,
        format: this.#presentationFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT
      });

      return {
        colorAttachments: [{
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

  // ===== PUBLIC GETTERS =====

  get device() { return this.#device; }
  get presentationFormat() { return this.#presentationFormat; }
  get msaaSampleCount() { return this.#msaaSampleCount; }
  get isInitialized() { return this.#initialized; }

  // Debug getters (development only)
  get _registeredCharts() { return this.#registeredCharts; }
  get _sharedResources() { return this.#sharedResources; }
  get _renderQueue() { return this.#renderQueue; }
  get _needsRedraw() { return this.#needsRedraw; }
  get _rafId() { return this.#rafId; }

  // ===== MONITORING AND DEBUGGING =====

  getResourceStats() {
    return {
      pipelines: Array.from(this.#sharedResources.pipelines.entries()).map(([type, resource]) => ({
        type,
        refCount: resource.refCount,
        ageMs: Date.now() - resource.createdAt
      })),
      shaders: Array.from(this.#sharedResources.shaderModules.entries()).map(([type, resource]) => ({
        type,
        refCount: resource.refCount,
        ageMs: Date.now() - resource.createdAt
      })),
      uniformBuffers: Array.from(this.#sharedResources.uniformBuffers.entries()).map(([name, resource]) => ({
        name,
        refCount: resource.refCount,
        ageMs: Date.now() - resource.createdAt
      }))
    };
  }

  getPerformanceStats() {
    return {
      resourceStats: this.getResourceStats(),
      renderBatches: {
        markTypeBatches: this.#renderBatches.byMarkType.size,
        zIndexBatches: this.#renderBatches.byZIndex.size,
        needsRebuild: this.#renderBatches.needsRebuild
      },
      registeredCharts: this.#registeredCharts.size,
      lastRenderTime: this.#lastRenderTime
    };
  }

  debug() {
    if (!this.debugger) {
      console.warn('Debugging not enabled for this coordinator');
      return {};
    }

    return {
      logState: () => this.debugger.logCoordinationState(),
      analyzeUsage: () => this.debugger.analyzeResourceUsage(),
      debugChart: (chartId) => this.debugger.debugChart(chartId),
      getStats: () => this.getPerformanceStats()
    };
  }

  // ===== CLEANUP =====

  destroy() {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }

    // Destroy shared resources
    for (const resource of this.#sharedResources.uniformBuffers.values()) {
      resource.buffer.destroy();
    }

    this.#sharedResources.uniformBuffers.clear();
    this.#sharedResources.pipelines.clear();
    this.#sharedResources.shaderModules.clear();

    if (this.#device) {
      this.#device.destroy();
    }

    this.#registeredCharts.clear();
    this.#renderQueue = [];
    this.#initialized = false;

    console.log('🧹 GPUCoordinator destroyed');
  }
}

// ===== CONTEXT FUNCTIONS =====

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

// Development helper for browser console
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  window.debugGPUCoordination = () => {
    const coordinator = window.__DEBUG_GPU_COORDINATOR;
    if (coordinator) {
      return coordinator.debug();
    } else {
      console.error('No GPU coordinator found. Make sure debugging is enabled.');
    }
  };
}