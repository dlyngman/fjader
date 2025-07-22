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
  
  const dotsShaderCode = `
    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec4<f32>,
      @location(1) uv: vec2<f32>,
      @location(2) radius: f32,
      @location(3) alpha: f32,
    };

    @group(0) @binding(0) var<uniform> resolution: vec2<f32>;
    @group(0) @binding(1) var<storage, read> xValues: array<f32>;
    @group(0) @binding(2) var<storage, read> yValues: array<f32>;
    @group(0) @binding(3) var<storage, read> radiusValues: array<f32>;
    @group(0) @binding(4) var<storage, read> alphaValues: array<f32>;
    @group(0) @binding(5) var<storage, read> colors: array<vec4<f32>>;
    @group(0) @binding(6) var<uniform> scaleParams: ScaleParams;
    @group(0) @binding(7) var<uniform> devicePixelRatio: f32;
    
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
      
      // Use centralized scale functions - works for any scale type!
      let scaledX = scaleX(x, scaleParams);
      let scaledY = scaleY(y, scaleParams);
      
      let displayRadius = radius * devicePixelRatio;
      let radiusWithPadding = displayRadius * 1.2;
      let worldPos = vec2<f32>(scaledX * devicePixelRatio, scaledY * devicePixelRatio) + quadPosition * radiusWithPadding;
      let normalizedPos = (worldPos / resolution) * 2.0 - 1.0;
      
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
      let pixelSize = devicePixelRatio / (input.radius * 2.0);
      let alpha = 1.0 - smoothstep(-pixelSize, pixelSize, sdf);
      let finalAlpha = input.color.a * alpha * input.alpha;
      return vec4<f32>(input.color.rgb, finalAlpha);
    }
  `;

  const shaderCode = BaseGPURenderer.generateShader(dotsShaderCode);

  // Dots-specific vertex buffer layout
  const vertexBufferLayout = [{
    arrayStride: 2 * 4, // 2 floats * 4 bytes
    attributes: [{
      shaderLocation: 0,
      offset: 0,
      format: 'float32x2',
    }],
  }];

  $effect(() => {
    if (xData && renderer?.resourcesCreated) {
      xBuffer = renderer.createOrUpdateBuffer(xBuffer, xData);
    }
  });

  $effect(() => {
    if (yData && renderer?.resourcesCreated) {
      yBuffer = renderer.createOrUpdateBuffer(yBuffer, yData);
    }
  });

  $effect(() => {
    if (colorData && renderer?.resourcesCreated) {
      colorBuffer = renderer.createOrUpdateBuffer(colorBuffer, colorData);
    }
  });

  $effect(() => {
    if (radiusData && renderer?.resourcesCreated) {
      radiusBuffer = renderer.createOrUpdateBuffer(radiusBuffer, radiusData);
    }
  });

  $effect(() => {
    if (alphaData && renderer?.resourcesCreated) {
      alphaBuffer = renderer.createOrUpdateBuffer(alphaBuffer, alphaData);
    }
  });

  let bindGroupReady = $derived(!!renderer?.bindGroup);

  $effect(() => {
    void renderer?.resourcesCreated;
    void bindGroupReady;


    if (xBuffer && yBuffer && radiusBuffer && alphaBuffer && colorBuffer && 
        renderer?.resourcesCreated && !bindGroupReady) {
      untrack(() => {
        createDotsBindGroup();
      });
    }
  });

  $effect(() => {
    void bindGroupReady;
    if (xData && xBuffer && bindGroupReady) {
      untrack(() => {
        const device = webGPUContext.getDevice();
        device?.queue.writeBuffer(xBuffer, 0, xData);
      });
    }
  });

  $effect(() => {
    void bindGroupReady;
    if (yData && yBuffer && bindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(yBuffer, 0, yData);
    }
  });

  $effect(() => {
    void bindGroupReady;
    if (radiusData && radiusBuffer && bindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(radiusBuffer, 0, radiusData);
    }
  });

  $effect(() => {
    void bindGroupReady;
    if (colorData && colorBuffer && bindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(colorBuffer, 0, colorData);
    }
  });

  $effect(() => {
    void bindGroupReady;
    if (alphaData && alphaBuffer && bindGroupReady) {
      const device = webGPUContext.getDevice();
      device?.queue.writeBuffer(alphaBuffer, 0, alphaData);
    }
  });

  $effect(() => {
    void bindGroupReady;
    if (xData && yData && colorData && radiusData && alphaData && 
        xBuffer && yBuffer && radiusBuffer && alphaBuffer && colorBuffer &&
        bindGroupReady) {
      renderer.updateInstanceCount(xData.length);
      gpuCoordinator.invalidateChart(chartContext.chartId);
    }
  });

  // Resize change
  $effect(() => {
    if (!renderer?.resourcesCreated) return;
    
    // Track layout changes
    void chartContext.innerWidth;
    void chartContext.innerHeight;
    
    untrack(() => {
      // Update scale uniforms only
      renderer.handleScaleOrRangeUpdate();
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

  // Initialize dots-specific geometry
  async function initializeDotsGeometry() {
    const device = webGPUContext.getDevice();
    if (!device) {
      throw new Error('No WebGPU device available');
    }

    // Create quad geometry buffer
    const quadVertices = createQuadGeometry();
    quadGeometryBuffer = device.createBuffer({
      size: quadVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(quadGeometryBuffer, 0, quadVertices);
  }


  // Create dots-specific bind group
  function createDotsBindGroup() {
    // Validate all buffers exist
    if (!xBuffer || !yBuffer || !radiusBuffer || !alphaBuffer || !colorBuffer) {
      console.warn('⚠️ Cannot create dots bind group - missing data buffers');
      return;
    }

    // Shape-specific bindings (bindings 1-5)
    const dotsBindings = [
      { binding: 1, resource: { buffer: xBuffer } },
      { binding: 2, resource: { buffer: yBuffer } },
      { binding: 3, resource: { buffer: radiusBuffer } },
      { binding: 4, resource: { buffer: alphaBuffer } },
      { binding: 5, resource: { buffer: colorBuffer } },
    ];

    // Use base renderer to create bind group (includes common bindings)
    renderer.createBindGroup(dotsBindings);
  }

  // Dots-specific draw function
  function drawDots(passEncoder) {
    // console.log('Dots draw operation started');

    try {
      if (!renderer?.pipeline || !renderer?.bindGroup || renderer.instanceCount === 0) {
        console.debug('⚠️ Skipping dots draw - resources not ready or no instances');
        return;
      }

      passEncoder.setPipeline(renderer.pipeline);
      passEncoder.setBindGroup(0, renderer.bindGroup);
      passEncoder.setVertexBuffer(0, quadGeometryBuffer);
      passEncoder.draw(quadVertexCount, renderer.instanceCount);

      // console.log('Dots draw operation completed');
      
    } catch (error) {
      console.error('❌ Dots draw operation failed:', error);
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
    
    await initializeDots();
  }

  // Initialize dots renderer
  async function initializeDots() {
    try {
      if (!gpuCoordinator) {
        throw new Error('GPU Coordinator context missing. Make sure setCoordinators() was called.');
      }

      // Create base renderer with scale type information
      renderer = new BaseGPURenderer('dots', webGPUContext, gpuCoordinator, chartContext, { 
        zIndex,
        xScaleType: chartContext.scaleTypes?.x || 'linear',
        yScaleType: chartContext.scaleTypes?.y || 'linear'
      });

      // Initialize with dots-specific configuration using centralized shader
      await renderer.initialize({
        shaderCode, // This now includes universal scale support!
        vertexBufferLayout,
      });

      // Initialize dots-specific geometry
      await initializeDotsGeometry();
      
      // Register layer with base renderer
      renderer.registerLayer(drawDots);

    } catch (error) {
      console.error('❌ Dots component initialization failed:', error);
      initializationError = error.message;
      throw error;
    }
  }

  onMount(async () => {
    try {
      await waitForWebGPU();
    } catch (error) {
      console.error('❌ Dots component mount failed:', error);
      initializationError = error.message;
    }
  });

  onDestroy(() => {
    // console.log('🧹 Cleaning up Dots component');
    
    try {
      // Clean up dots-specific resources
      if (quadGeometryBuffer && !quadGeometryBuffer.destroyed) {
        quadGeometryBuffer.destroy();
      }

      // Base renderer handles all other cleanup
      if (renderer) {
        renderer.destroy();
      }

      // console.log('✅ Dots component cleanup complete');
      
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