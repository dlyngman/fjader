<script>
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
  import { BaseGPURenderer } from './BaseGPURenderer.svelte.js';
  import { getGPUContext } from '$lib/gpu';

  let { 
    x0Data,       // Float32Array - left edges
    x1Data,       // Float32Array - right edges  
    y0Data,       // Float32Array - bottom edges
    y1Data,       // Float32Array - top edges
    colorData,    // Float32Array - RGBA colors (instanceCount * 4)
    alphaData,    // Float32Array - alpha values
    dataVersion,  // number - for triggering updates
    zIndex = 0,
  } = $props();

  const chartContext = getContext('chart');
  const webGPUContext = getContext('webgpu-canvas');
  const gpuCoordinator = getGPUContext();

  // Renderer and buffer state
  let renderer = $state(null);
  let initializationError = $state(null);

  // GPU buffers
  let x0Buffer, x1Buffer, y0Buffer, y1Buffer, colorBuffer, alphaBuffer, rectGeometryBuffer;

  const rectVertexCount = 6;
  
  // ✅ NEW: Shader built for dual bind group architecture with interpolation
  const rectsShaderCode = `
    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec4<f32>,
    };

    // ✅ NEW: Data storage buffers in @group(1) - all 6 channels fit perfectly!
    @group(1) @binding(0) var<storage, read> x0Values: array<f32>;
    @group(1) @binding(1) var<storage, read> x1Values: array<f32>;
    @group(1) @binding(2) var<storage, read> y0Values: array<f32>;
    @group(1) @binding(3) var<storage, read> y1Values: array<f32>;
    @group(1) @binding(4) var<storage, read> colors: array<vec4<f32>>;
    @group(1) @binding(5) var<storage, read> alphaValues: array<f32>;
    
    @vertex
    fn vertexMain(
    @location(0) rectCorner: vec2<f32>, // Unit square corner (0,0 to 1,1)
    @builtin(instance_index) instanceIdx: u32,
    ) -> VertexOutput {
    // Get rectangle bounds from buffers
    let x0 = x0Values[instanceIdx];
    let x1 = x1Values[instanceIdx];
    let y0 = y0Values[instanceIdx];
    let y1 = y1Values[instanceIdx];
    let alpha = alphaValues[instanceIdx];
    let color = colors[instanceIdx];
    
    // ✅ ENHANCED: Use detailed scale functions for band scale support
    let xResult0 = scaleXDetailed(x0, scaleParams);
    let xResult1 = scaleXDetailed(x1, scaleParams);
    let yResult0 = scaleYDetailed(y0, scaleParams);
    let yResult1 = scaleYDetailed(y1, scaleParams);
    
    // Calculate final rectangle bounds
    var scaledX0: f32;
    var scaledX1: f32;
    var scaledY0: f32;
    var scaledY1: f32;
    
    // Handle X axis scaling
    if (scaleParams.scaleTypes.x == 1.0) {
        // Band scale: use position + full bandwidth
        scaledX0 = xResult0.position;
        scaledX1 = xResult0.position + xResult0.bandwidth;
    } else {
        // Linear scale: use scaled positions
        scaledX0 = xResult0.position;
        scaledX1 = xResult1.position;
    }
    
    // Handle Y axis scaling  
    if (scaleParams.scaleTypes.y == 1.0) {
        // Band scale: use position + full bandwidth (for bars)
        scaledY0 = yResult0.position;
        scaledY1 = yResult0.position + yResult0.bandwidth;
    } else {
        // Linear scale: use scaled positions
        scaledY0 = yResult0.position;
        scaledY1 = yResult1.position;
    }
    
    // ✅ UNCHANGED: Interpolate between corners using unit square coordinates
    let finalX = mix(scaledX0, scaledX1, rectCorner.x);
    let finalY = mix(scaledY0, scaledY1, rectCorner.y);
    
    // Convert to normalized device coordinates
    let worldPos = vec2<f32>(finalX * devicePixelRatio, finalY * devicePixelRatio);
    let normalizedPos = (worldPos / resolution) * 2.0 - 1.0;
    
    var output: VertexOutput;
    output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
    output.color = vec4<f32>(color.rgb, color.a * alpha);
    return output;
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
      return input.color;
    }
  `;

  const shaderCode = BaseGPURenderer.generateShader(rectsShaderCode);

  // Rectangle-specific vertex buffer layout
  const vertexBufferLayout = [{
    arrayStride: 2 * 4, // 2 floats * 4 bytes
    attributes: [{
      shaderLocation: 0,
      offset: 0,
      format: 'float32x2',
    }],
  }];

  // ✅ NEW: Data binding configuration - all 6 channels for dual bind group architecture
  const dataBindingConfig = [
    { binding: 0, type: 'read-only-storage' }, // x0Values
    { binding: 1, type: 'read-only-storage' }, // x1Values  
    { binding: 2, type: 'read-only-storage' }, // y0Values
    { binding: 3, type: 'read-only-storage' }, // y1Values
    { binding: 4, type: 'read-only-storage' }, // colors
    { binding: 5, type: 'read-only-storage' }, // alphaValues
  ];

  $effect(() => {
    console.log('🔍 Rects Renderer Status:', {
      rendererCreated: !!renderer,
      resourcesCreated: renderer?.resourcesCreated,
      initializationError: initializationError,
      
      // Props received from BarMarkX
      x0DataLength: x0Data?.length || 0,
      x1DataLength: x1Data?.length || 0,
      y0DataLength: y0Data?.length || 0,
      y1DataLength: y1Data?.length || 0,
      colorDataLength: colorData?.length || 0,
      alphaDataLength: alphaData?.length || 0,
      
      instanceCount: renderer?.instanceCount || 0,
      pipeline: !!renderer?.pipeline,
      
      // All bind groups (expect similar issue as Dots)
      perFrameBindGroup: !!renderer?.perFrameBindGroup,
      perDataBindGroup: !!renderer?.perDataBindGroup,
      perScaleBindGroup: !!renderer?.perScaleBindGroup,
      
      // GPU buffers
      buffers: {
        x0Buffer: !!x0Buffer,
        x1Buffer: !!x1Buffer,
        y0Buffer: !!y0Buffer,
        y1Buffer: !!y1Buffer,
        colorBuffer: !!colorBuffer,
        alphaBuffer: !!alphaBuffer,
        rectGeometry: !!rectGeometryBuffer
      }
    });
  });

  // Add this effect to Rects.svelte to monitor when scales/layout become ready
  $effect(() => {
    const layoutReady = chartContext?.layout?.isReady;
    const yScaleReady = !!chartContext?.yScale?.scale;
    const scaleType = chartContext?.scaleTypes?.y;
    
    console.log('🔍 Monitoring scale/layout readiness:', {
      layoutReady,
      yScaleReady,
      scaleType,
      innerHeight: chartContext?.layout?.innerHeight,
      bandwidth: chartContext?.yScale?.scale?.bandwidth?.()
    });
    
    // Force re-access when conditions change
    if (layoutReady && yScaleReady && scaleType === 'band') {
      console.log('🎯 All conditions met - forcing category position recalculation');
      const positions = chartContext?.yCategoryPositions;
      console.log('📍 Category positions now:', positions?.length || 'still null');
    }
  });

  // // Add this to Rects.svelte to see the full context structure
  // $effect(() => {
  //   console.log('🔍 Full chart context structure:', {
  //     // Check what properties actually exist
  //     contextKeys: Object.keys(chartContext || {}),
      
  //     // Check layout object
  //     layout: chartContext?.layout,
  //     layoutKeys: chartContext?.layout ? Object.keys(chartContext.layout) : 'no layout',
      
  //     // Check scale objects  
  //     xScale: chartContext?.xScale,
  //     yScale: chartContext?.yScale,
      
  //     // Check what ChartScales is providing
  //     scaleTypes: chartContext?.scaleTypes,
  //   });
  // });

  // Add this debugging effect to Rects.svelte
  // $effect(() => {
  //   console.log('🔍 Rects debug - chart context access:', {
  //       chartContext: !!chartContext,
  //       scaleTypes: chartContext?.scaleTypes,
  //       xCategoryPositions: chartContext?.xCategoryPositions?.length || 'null',
  //       yCategoryPositions: chartContext?.yCategoryPositions?.length || 'null',
  //       categoryPositionsReady: chartContext?.categoryPositionsReady,
  //       layout: {
  //         isReady: chartContext?.layout?.isReady,
  //         innerHeight: chartContext?.layout?.innerHeight,
  //         innerWidth: chartContext?.layout?.innerWidth
  //       },
  //       scales: {
  //         xScale: !!chartContext?.xScale?.scale,
  //         yScale: !!chartContext?.yScale?.scale,
  //         yBandwidth: chartContext?.yScale?.scale?.bandwidth?.()
  //       },
  //       yScaleState: {
  //         type: chartContext?.yScaleState?.constructor?.name,
  //         effectiveDomain: chartContext?.yScaleState?.effectiveDomain,
  //         ready: chartContext?.yScaleState?.ready
  //       }
  //   });
  // });

  // $effect(() => {
  //   console.log('🔍 Chart Context Deep Debug:', {
  //     // Direct property access
  //     chartContextKeys: Object.keys(chartContext),
      
  //     // Layout access
  //     isReady: chartContext.isReady,
  //     innerWidth: chartContext.innerWidth,
  //     innerHeight: chartContext.innerHeight,
      
  //     // Scale access  
  //     scaleTypes: chartContext.scaleTypes,
  //     yScaleState: chartContext.yScaleState,
      
  //     // Category positions
  //     yCategoryPositions: chartContext.yCategoryPositions,
  //     categoryPositionsReady: chartContext.categoryPositionsReady,
      
  //     // Try accessing the computed property directly
  //     yScale: chartContext.yScale,
  //     yScaleDomain: chartContext.yScaleState?.effectiveDomain,
  //   });
  // });

  // Category position monitoring effects
  $effect(() => {
    if (!renderer?.resourcesCreated) return;

    // console.log('runing ')
    const xPositions = chartContext.xCategoryPositions;
    const yPositions = chartContext.yCategoryPositions;
    const categoryPositionsReady = chartContext.categoryPositionsReady;

    if (categoryPositionsReady) {
      renderer.updateCategoryPositions();
    }
  });

  // $effect(() => {
  //   const yPositions = chartContext.yCategoryPositions;
  //   if (yPositions && renderer?.resourcesCreated) {
  //     renderer.updateCategoryPositions();
  //   }
  // });

    // Scale parameter effects
  $effect(() => {
    const scaleTypes = chartContext.scaleTypes;
    const xScale = chartContext.xScale;
    const yScale = chartContext.yScale;
    
    if (renderer?.resourcesCreated) {
      renderer.updateScaleParameters();
    }
  });

  // Resolution effects
  $effect(() => {
    const layout = chartContext.layout;
    if (layout?.isReady && renderer?.resourcesCreated) {
      renderer.updateResolution();
    }
  });

  // Buffer update effects
  $effect(() => {
    if (x0Data && renderer?.resourcesCreated) {
      x0Buffer = renderer.createOrUpdateBuffer(x0Buffer, x0Data);
    }
  });

  $effect(() => {
    if (x1Data && renderer?.resourcesCreated) {
      x1Buffer = renderer.createOrUpdateBuffer(x1Buffer, x1Data);
    }
  });

  $effect(() => {
    if (y0Data && renderer?.resourcesCreated) {
      y0Buffer = renderer.createOrUpdateBuffer(y0Buffer, y0Data);
    }
  });

  $effect(() => {
    if (y1Data && renderer?.resourcesCreated) {
      y1Buffer = renderer.createOrUpdateBuffer(y1Buffer, y1Data);
    }
  });

  $effect(() => {
    if (colorData && renderer?.resourcesCreated) {
      colorBuffer = renderer.createOrUpdateBuffer(colorBuffer, colorData);
    }
  });

  $effect(() => {
    if (alphaData && renderer?.resourcesCreated) {
      alphaBuffer = renderer.createOrUpdateBuffer(alphaBuffer, alphaData);
    }
  });

  // Check for per-data bind group readiness
  let dataBindGroupReady = $derived(!!renderer?.perDataBindGroup);

  $effect(() => {
    void renderer?.resourcesCreated;
    void dataBindGroupReady;

    if (x0Buffer && x1Buffer && y0Buffer && y1Buffer && colorBuffer && alphaBuffer && 
        renderer?.resourcesCreated && !dataBindGroupReady) {
      untrack(() => {
        createRectsDataBindGroup();
      });
    }
  });

  // Data writing effects
  $effect(() => {
    void dataBindGroupReady;
    if (x0Data && x0Buffer && dataBindGroupReady) {
      untrack(() => {
        const device = webGPUContext.getDevice();
        device?.queue.writeBuffer(x0Buffer, 0, x0Data);
      });
    }
  });

  $effect(() => {
    void dataBindGroupReady;
    if (x1Data && x1Buffer && dataBindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(x1Buffer, 0, x1Data);
    }
  });

  $effect(() => {
    void dataBindGroupReady;
    if (y0Data && y0Buffer && dataBindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(y0Buffer, 0, y0Data);
    }
  });

  $effect(() => {
    void dataBindGroupReady;
    if (y1Data && y1Buffer && dataBindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(y1Buffer, 0, y1Data);
    }
  });

  $effect(() => {
    void dataBindGroupReady;
    if (colorData && colorBuffer && dataBindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(colorBuffer, 0, colorData);
    }
  });

  $effect(() => {
    void dataBindGroupReady;
    if (alphaData && alphaBuffer && dataBindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(alphaBuffer, 0, alphaData);
    }
  });

  $effect(() => {
    void dataBindGroupReady;
    if (x0Data && x1Data && y0Data && y1Data && colorData && alphaData && 
        x0Buffer && x1Buffer && y0Buffer && y1Buffer && colorBuffer && alphaBuffer &&
        dataBindGroupReady) {
      renderer.updateInstanceCount(x0Data.length);
      gpuCoordinator.invalidateChart(chartContext.chartId);
    }
  });

  // Resize change
  $effect(() => {
    if (!renderer?.resourcesCreated) return;
    
    // Track layout changes
    void chartContext.innerWidth;
    void chartContext.innerHeight;
    // void chartContext.yBandwidth;
    // void chartContext.xBandwidth;
    
    untrack(() => {
      // Update scale uniforms only
      renderer.handleScaleOrRangeUpdate();
      renderer.handleResolutionChange();      
      gpuCoordinator.invalidateChart(chartContext.chartId);
    });
  });

  // Create unit square geometry for rectangle rendering
  function createRectGeometry() {
    return new Float32Array([
      0, 0,  // bottom-left  (x0, y0)
      1, 0,  // bottom-right (x1, y0)
      0, 1,  // top-left     (x0, y1)
      1, 0,  // bottom-right (x1, y0)
      1, 1,  // top-right    (x1, y1)
      0, 1,  // top-left     (x0, y1)
    ]);
  }

  // Initialize rectangle-specific geometry
  // async function initializeRectGeometry() {
  //   const device = webGPUContext.getDevice();
  //   if (!device) {
  //     throw new Error('No WebGPU device available');
  //   }

  //   // Create unit square geometry buffer
  //   const rectVertices = createRectGeometry();
  //   rectGeometryBuffer = device.createBuffer({
  //     size: rectVertices.byteLength,
  //     usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  //     label: 'rects-unit-square-geometry'
  //   });
  //   device.queue.writeBuffer(rectGeometryBuffer, 0, rectVertices);
  // }
  async function initializeRectGeometry() {
    try {
      const device = webGPUContext.getDevice();
      if (!device) {
        throw new Error('No WebGPU device available');
      }

      console.log('🔧 Creating rect geometry...');
      
      // Create unit square geometry buffer
      const rectVertices = createRectGeometry();
      console.log('📐 Rect vertices:', rectVertices);
      
      rectGeometryBuffer = device.createBuffer({
        size: rectVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: 'rects-unit-square-geometry'
      });
      device.queue.writeBuffer(rectGeometryBuffer, 0, rectVertices);
      
      console.log('✅ Rect geometry created successfully:', {
        buffer: !!rectGeometryBuffer,
        size: rectVertices.byteLength,
        vertices: rectVertices.length
      });
      
    } catch (error) {
      console.error('❌ Failed to create rect geometry:', error);
      throw error;
    }
  }

  // ✅ NEW: Create rectangles-specific data bind group using dual bind group architecture
  function createRectsDataBindGroup() {
    // Validate all buffers exist
    if (!x0Buffer || !x1Buffer || !y0Buffer || !y1Buffer || !colorBuffer || !alphaBuffer) {
      console.warn('⚠️ Cannot create rects data bind group - missing data buffers');
      return;
    }

    // ✅ NEW: Create data bindings for @group(1) - all 6 channels!
    const dataBindings = [
      { binding: 0, resource: { buffer: x0Buffer } },     // x0Values
      { binding: 1, resource: { buffer: x1Buffer } },     // x1Values
      { binding: 2, resource: { buffer: y0Buffer } },     // y0Values
      { binding: 3, resource: { buffer: y1Buffer } },     // y1Values
      { binding: 4, resource: { buffer: colorBuffer } },  // colors
      { binding: 5, resource: { buffer: alphaBuffer } },  // alphaValues
    ];

    // ✅ NEW: Use dual bind group architecture
    renderer.createDataBindGroup(dataBindings);
    
    console.debug('✅ Rects data bind group created with 6 channels using dual bind group architecture');
  }

  // ✅ NEW: Rectangle-specific draw function for dual bind groups
  function drawRects(passEncoder) {
    // console.log('🎨 drawRects called:', {
    //   instanceCount: renderer.instanceCount,
    //   rectBuffer: !!rectGeometryBuffer,
    //   allBindGroups: !!(renderer.perFrameBindGroup && renderer.perDataBindGroup && renderer.perScaleBindGroup)
    // });
    try {
      if (!renderer?.pipeline || 
          !renderer?.perFrameBindGroup || 
          !renderer?.perDataBindGroup || 
          !renderer?.perScaleBindGroup ||
          renderer.instanceCount === 0) {
        console.debug('⚠️ Skipping rects draw - resources not ready or no instances');
        return;
      }

      if (!rectGeometryBuffer) {
        console.error('❌ Skipping rects draw - no rect geometry buffer!');
        return;
      }

      // console.log('✅ Drawing rects:', renderer.instanceCount, 'instances');

      passEncoder.setPipeline(renderer.pipeline);
      passEncoder.setBindGroup(0, renderer.perFrameBindGroup);
      passEncoder.setBindGroup(1, renderer.perDataBindGroup);  
      passEncoder.setBindGroup(2, renderer.perScaleBindGroup);   
      passEncoder.setVertexBuffer(0, rectGeometryBuffer);
      passEncoder.draw(rectVertexCount, renderer.instanceCount);

      // console.log('✅ Rects draw completed successfully');

    //   console.debug(`✅ Rects draw completed: ${renderer.instanceCount} rectangles with dual bind groups`);
      
    } catch (error) {
      console.error('❌ Rects draw operation failed:', error);
      throw error;
    }
  }

  // Wait for WebGPU context with better error handling
  async function waitForWebGPU() {
    let attempts = 0;
    const maxAttempts = 100;
    
    while (!webGPUContext.isInitialized() && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 50));
      attempts++;
    }
    
    if (!webGPUContext.isInitialized()) {
      throw new Error(`WebGPU context failed to initialize within ${maxAttempts * 50}ms`);
    }
    
    await initializeRects();
  }

  // ✅ NEW: Initialize rectangles renderer with dual bind group architecture
  async function initializeRects() {
    try {
      if (!gpuCoordinator) {
        throw new Error('GPU Coordinator context missing. Make sure setCoordinators() was called.');
      }

      // Create base renderer with scale type information
      renderer = new BaseGPURenderer('rects', webGPUContext, gpuCoordinator, chartContext, { 
        zIndex,
        xScaleType: chartContext.scaleTypes?.x || 'linear',
        yScaleType: chartContext.scaleTypes?.y || 'linear'
      });

      // ✅ NEW: Initialize with dual bind group configuration including all 6 data channels
      await renderer.initialize({
        shaderCode,               // Generated shader with @group annotations
        vertexBufferLayout,       // Vertex layout for unit square geometry
        dataBindingConfig,        // ✅ NEW: 6 channels - wouldn't fit in old architecture!
      });

      // Initialize rectangle-specific geometry
      await initializeRectGeometry();
      
      // Register layer with base renderer
      renderer.registerLayer(drawRects);

      console.log('✅ Rects component initialized with dual bind group architecture (6 data channels)');

    } catch (error) {
      console.error('❌ Rects component initialization failed:', error);
      initializationError = error.message;
      throw error;
    }
  }

  onMount(async () => {
    try {
      await waitForWebGPU();
    } catch (error) {
      console.error('❌ Rects component mount failed:', error);
      initializationError = error.message;
    }
  });

  onDestroy(() => {
    try {
      // Clean up rectangle-specific resources
      if (rectGeometryBuffer && !rectGeometryBuffer.destroyed) {
        rectGeometryBuffer.destroy();
      }

      // Base renderer handles all other cleanup
      if (renderer) {
        renderer.destroy();
      }
      
    } catch (error) {
      console.error('❌ Error during Rects component cleanup:', error);
    }
  });
</script>

{#if initializationError}
  <div class="rects-error">
    <p>Rects component failed to initialize:</p>
    <p class="error-message">{initializationError}</p>
  </div>
{/if}

<style>
  .rects-error {
    position: absolute;
    top: 10px;
    left: 10px;
    background-color: rgba(255, 240, 240, 0.9);
    border: 1px solid #ffcccb;
    border-radius: 4px;
    padding: 8px 12px;
    font-size: 12px;
    color: #d32f2f;
    z-index: 1000;
    max-width: 300px;
  }

  .error-message {
    font-family: monospace;
    background-color: rgba(255, 255, 255, 0.8);
    padding: 4px 6px;
    border-radius: 2px;
    margin-top: 4px;
    font-size: 11px;
  }
</style>