<script>
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
  import { BaseGPURenderer } from './BaseGPURenderer.svelte.js';
  import { getGPUContext } from '$lib/gpu';

  let { 
    xData,        // Float32Array - processed X positions
    yData,        // Float32Array - processed Y positions  
    colorData,    // Float32Array - RGBA colors (instanceCount * 4)
    radiusData,   // Float32Array - radius values
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
  let xBuffer, yBuffer, radiusBuffer, alphaBuffer, colorBuffer, quadGeometryBuffer;

  const quadVertexCount = 6;
  
  // ✅ UPDATED: Shader now uses @group(1) for data bindings
  const dotsShaderCode = `
    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec4<f32>,
      @location(1) uv: vec2<f32>,
      @location(2) radius: f32,
      @location(3) alpha: f32,
    };

    // ✅ UPDATED: Data storage buffers now in @group(1) with restarted binding indices
    @group(1) @binding(0) var<storage, read> xValues: array<f32>;
    @group(1) @binding(1) var<storage, read> yValues: array<f32>;
    @group(1) @binding(2) var<storage, read> radiusValues: array<f32>;
    @group(1) @binding(3) var<storage, read> alphaValues: array<f32>;
    @group(1) @binding(4) var<storage, read> colors: array<vec4<f32>>;
    
    @vertex
    fn vertexMain(
      @location(0) quadPosition: vec2<f32>,
      @builtin(instance_index) instanceIdx: u32,
    ) -> VertexOutput {
      // Get values from separate buffers
      let x = xValues[instanceIdx];
      let y = yValues[instanceIdx];
      let radius = radiusValues[instanceIdx];
      let alpha = alphaValues[instanceIdx];
      let color = colors[instanceIdx];
      
      // Use centralized scale functions
      let scaledX = scaleX(x);
      let scaledY = scaleY(y);
      
      let displayRadius = radius * frameUniforms.devicePixelRatio;
      let radiusWithPadding = displayRadius * 1.2;
      let worldPos = vec2<f32>(scaledX * frameUniforms.devicePixelRatio, scaledY * frameUniforms.devicePixelRatio) + quadPosition * radiusWithPadding;
      let normalizedPos = (worldPos / frameUniforms.resolution) * 2.0 - 1.0;
      
      var output: VertexOutput;
      output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
      output.color = color;
      output.uv = quadPosition;
      output.radius = displayRadius;
      output.alpha = alpha;
      return output;
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
      let dist = length(input.uv);
      let sdf = dist - 1.0;
      let pixelSize = frameUniforms.devicePixelRatio / (input.radius * 2.0);
      let alpha = 1.0 - smoothstep(-pixelSize, pixelSize, sdf);
      let finalAlpha = input.color.a * alpha * input.alpha;
      return vec4<f32>(input.color.rgb, finalAlpha);
    }
  `;

  // const shaderCode = BaseGPURenderer.generateShader(dotsShaderCode);

  // Dots-specific vertex buffer layout
  const vertexBufferLayout = [{
    arrayStride: 2 * 4, // 2 floats * 4 bytes
    attributes: [{
      shaderLocation: 0,
      offset: 0,
      format: 'float32x2',
    }],
  }];

  // ✅ NEW: Data binding configuration for dual bind group architecture
  const dataBindingConfig = [
    { binding: 0, type: 'read-only-storage' }, // xValues
    { binding: 1, type: 'read-only-storage' }, // yValues  
    { binding: 2, type: 'read-only-storage' }, // radiusValues
    { binding: 3, type: 'read-only-storage' }, // alphaValues
    { binding: 4, type: 'read-only-storage' }, // colors
  ];

  $effect(() => {
    if (renderer?.resourcesCreated) {
      console.log('Renderer debug:', {
        pipeline: !!renderer.pipeline,
        perFrameBindGroup: !!renderer.perFrameBindGroup,
        perDataBindGroup: !!renderer.perDataBindGroup, 
        perScaleBindGroup: !!renderer.perScaleBindGroup,  // ← Check this
        instanceCount: renderer.instanceCount
      });
    }
  });

  $effect(() => {
    console.log('📥 Dots received props:', {
      xData: xData ? `${xData.length} items` : 'null',
      yData: yData ? `${yData.length} items` : 'null',
      colorData: colorData ? `${colorData.length/4} colors` : 'null',
      dataVersion
    });
  });

  // Buffer update effects
  $effect.pre(() => {
    if (xData && renderer?.resourcesCreated) {
      xBuffer = renderer.createOrUpdateBuffer(xBuffer, xData);
    }
  });

  $effect.pre(() => {
    if (yData && renderer?.resourcesCreated) {
      yBuffer = renderer.createOrUpdateBuffer(yBuffer, yData);
    }
  });

  $effect.pre(() => {
    if (colorData && renderer?.resourcesCreated) {
      colorBuffer = renderer.createOrUpdateBuffer(colorBuffer, colorData);
    }
  });

  $effect.pre(() => {
    if (radiusData && renderer?.resourcesCreated) {
      radiusBuffer = renderer.createOrUpdateBuffer(radiusBuffer, radiusData);
    }
  });

  $effect.pre(() => {
    if (alphaData && renderer?.resourcesCreated) {
      alphaBuffer = renderer.createOrUpdateBuffer(alphaBuffer, alphaData);
    }
  });

  // ✅ UPDATED: Check for per-data bind group instead of legacy bindGroup
  let dataBindGroupReady = $derived(!!renderer?.perDataBindGroup);
  let allBindGroupsReady = $derived(
    !!renderer?.perFrameBindGroup && 
    !!renderer?.perDataBindGroup 
    // && !!renderer?.perScaleBindGroup
  );

  $effect.pre(() => {
    void renderer?.resourcesCreated;
    void dataBindGroupReady;

    if (xBuffer && yBuffer && radiusBuffer && alphaBuffer && colorBuffer && 
        renderer?.resourcesCreated && !dataBindGroupReady) {
      untrack(() => {
        createDotsDataBindGroup();
      });
    }
  });

  // Data writing effects
  $effect.pre(() => {
    void dataBindGroupReady;
    if (xData && xBuffer && dataBindGroupReady) {
      untrack(() => {
        const device = webGPUContext.getDevice();
        device?.queue.writeBuffer(xBuffer, 0, xData);
      });
    }
  });

  $effect.pre(() => {
    void dataBindGroupReady;
    if (yData && yBuffer && dataBindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(yBuffer, 0, yData);
    }
  });

  $effect.pre(() => {
    void dataBindGroupReady;
    if (radiusData && radiusBuffer && dataBindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(radiusBuffer, 0, radiusData);
    }
  });

  $effect.pre(() => {
    void dataBindGroupReady;
    if (colorData && colorBuffer && dataBindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(colorBuffer, 0, colorData);
    }
  });

  $effect.pre(() => {
    void dataBindGroupReady;
    if (alphaData && alphaBuffer && dataBindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(alphaBuffer, 0, alphaData);
    }
  });

  $effect.pre(() => {
    void dataBindGroupReady;
    if (xData && yData && colorData && radiusData && alphaData && 
        xBuffer && yBuffer && radiusBuffer && alphaBuffer && colorBuffer &&
        dataBindGroupReady) {
      renderer.updateInstanceCount(xData.length);
      gpuCoordinator.invalidateChart(chartContext.chartId);
    }
  });

  // Resize change
  $effect.pre(() => {
    if (!renderer?.resourcesCreated) return;
    
    // Track layout changes
    void chartContext.innerWidth;
    void chartContext.innerHeight;
    
    untrack(() => {
      // Update scale uniforms only
      // renderer.handleScaleOrRangeUpdate();
      renderer.handleResolutionChange();      
      gpuCoordinator.invalidateChart(chartContext.chartId);
    });
  });

  // Create quad geometry for dot rendering
  function createQuadGeometry() {
    return new Float32Array([
      -1, -1,  // bottom-left
       1, -1,  // bottom-right
      -1,  1,  // top-left
       1, -1,  // bottom-right
       1,  1,  // top-right
      -1,  1,  // top-left
    ]);
  }

  // // Initialize dots-specific geometry
  // async function initializeDotsGeometry() {
  //   const device = webGPUContext.getDevice();
  //   if (!device) {
  //     throw new Error('No WebGPU device available');
  //   }

  //   // Create quad geometry buffer
  //   const quadVertices = createQuadGeometry();
  //   quadGeometryBuffer = device.createBuffer({
  //     size: quadVertices.byteLength,
  //     usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  //     label: 'dots-quad-geometry'
  //   });
  //   device.queue.writeBuffer(quadGeometryBuffer, 0, quadVertices);
  // }
  // Replace the initializeDotsGeometry function in Dots.svelte
  async function initializeDotsGeometry() {
    try {
      const device = webGPUContext.getDevice();
      if (!device) {
        throw new Error('No WebGPU device available for quad geometry');
      }

      console.log('🔧 Creating quad geometry...');
      
      // Create quad geometry buffer
      const quadVertices = createQuadGeometry();
      console.log('📐 Quad vertices:', quadVertices);
      
      quadGeometryBuffer = device.createBuffer({
        size: quadVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: 'dots-quad-geometry'
      });
      
      device.queue.writeBuffer(quadGeometryBuffer, 0, quadVertices);
      
      console.log('✅ Quad geometry created successfully:', {
        buffer: !!quadGeometryBuffer,
        size: quadVertices.byteLength,
        vertices: quadVertices.length
      });
      
    } catch (error) {
      console.error('❌ Failed to create quad geometry:', error);
      throw error;
    }
  }

  // ✅ UPDATED: Create dots-specific data bind group using new architecture
  function createDotsDataBindGroup() {
    // Validate all buffers exist
    if (!xBuffer || !yBuffer || !radiusBuffer || !alphaBuffer || !colorBuffer) {
      console.warn('⚠️ Cannot create dots data bind group - missing data buffers');
      return;
    }

    // ✅ NEW: Create data bindings for @group(1) with restarted indices
    const dataBindings = [
      { binding: 0, resource: { buffer: xBuffer } },      // xValues
      { binding: 1, resource: { buffer: yBuffer } },      // yValues
      { binding: 2, resource: { buffer: radiusBuffer } }, // radiusValues
      { binding: 3, resource: { buffer: alphaBuffer } },  // alphaValues
      { binding: 4, resource: { buffer: colorBuffer } },  // colors
    ];

    // ✅ NEW: Use new dual bind group architecture
    renderer.createDataBindGroup(dataBindings);
    
    console.debug('✅ Dots data bind group created with dual bind group architecture');
  }

  // ✅ UPDATED: Dots-specific draw function for dual bind groups
  function drawDots(passEncoder) {
    try {
      if (!renderer?.pipeline || 
          !renderer?.perDataBindGroup || 
          renderer.instanceCount === 0) {
        console.debug('⚠️ Skipping dots draw - resources not ready or no instances');
        return;
      }

      if (!quadGeometryBuffer) {
        console.error('❌ Skipping dots draw - no quad geometry buffer!');
        console.log('❌ Early return - no quad geometry buffer');
        return;
      }

      passEncoder.setPipeline(renderer.pipeline);
      passEncoder.setVertexBuffer(0, quadGeometryBuffer);
      passEncoder.draw(quadVertexCount, renderer.instanceCount);

    } catch (error) {
      console.error('❌ Dots draw operation failed:', error);
      throw error;
    }
  }

  // Wait for WebGPU context with better error handling
  async function waitForWebGPU() {
    console.log('⏳ waitForWebGPU - starting...');
    let attempts = 0;
    const maxAttempts = 100;
    
    while (!webGPUContext.isInitialized() && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 50));
      attempts++;
    }
    
    if (!webGPUContext.isInitialized()) {
      throw new Error(`WebGPU context failed to initialize within ${maxAttempts * 50}ms`);
    }
    
    console.log('✅ WebGPU context ready, calling initializeDots...');
    await initializeDots();
  }

  // ✅ UPDATED: Initialize dots renderer with new dual bind group architecture
  async function initializeDots() {
    console.log('🔧 initializeDots - starting...');
    try {
      if (!gpuCoordinator) {
        throw new Error('GPU Coordinator context missing. Make sure setCoordinators() was called.');
      }

      console.log('📊 Creating base renderer...');
      // Create base renderer with scale type information
      renderer = new BaseGPURenderer('dots', webGPUContext, gpuCoordinator, chartContext, { 
        zIndex,
        xScaleType: chartContext.scaleTypes?.x || 'linear',
        yScaleType: chartContext.scaleTypes?.y || 'linear'
      });

      console.log('🔧 Initializing renderer...');

      // ✅ UPDATED: Initialize with dual bind group configuration
      await renderer.initialize({
        // shaderCode,               // Generated shader with @group annotations
        markShaderCode: dotsShaderCode, 
        vertexBufferLayout,       // Vertex layout for quad geometry
        dataBindingConfig,        // ✅ NEW: Required for dual bind group architecture
      });

      console.log('📐 Initializing dots geometry...');
      // Initialize dots-specific geometry
      await initializeDotsGeometry();
      
      console.log('📋 Registering layer...');
      // Register layer with base renderer
      renderer.registerLayer(drawDots);

      console.log('✅ Dots component initialized with dual bind group architecture');

    } catch (error) {
      console.error('❌ Dots component initialization failed:', error);
      initializationError = error.message;
      throw error;
    }
  }

  onMount(async () => {
    console.log('🚀 Dots onMount - starting initialization...');
    try {
      await waitForWebGPU();
      console.log('✅ Dots initialization completed successfully');
    } catch (error) {
      console.error('❌ Dots component mount failed:', error);
      initializationError = error.message;
    }
  });

  onDestroy(() => {
    try {
      // Clean up dots-specific resources
      if (quadGeometryBuffer && !quadGeometryBuffer.destroyed) {
        quadGeometryBuffer.destroy();
      }

      // Base renderer handles all other cleanup
      if (renderer) {
        renderer.destroy();
      }
      
    } catch (error) {
      console.error('❌ Error during Dots component cleanup:', error);
    }
  });
</script>

{#if initializationError}
  <div class="dots-error">
    <p>Dots component failed to initialize:</p>
    <p class="error-message">{initializationError}</p>
  </div>
{/if}

<style>
  .dots-error {
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