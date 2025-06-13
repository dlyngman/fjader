<script>
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
  import { getScaleState } from '$lib/scales';
  import { BaseGPURenderer } from './BaseGPURenderer.svelte.js';
  import { getGPUContext } from '$lib/gpu';

  let { 
    data, // Arrow Table
    dataVersion,
    r = 3,
    fill = 'blue',
    alpha = .5,
    zIndex = 0,
  } = $props();

  let colorScale = $derived(getScaleState('color', 'ordinal'));
  
  const c = getContext('chart');
  const webGPUContext = getContext('webgpu-canvas');
  const gpuCoordinator = getGPUContext();

  // Use BaseGPURenderer for common functionality
  let renderer = $state(null);
  let initializationError = $state(null);

  // Dots-specific buffers (managed through base renderer)
  let xBuffer;
  let yBuffer;
  let radiusBuffer;
  let alphaBuffer;
  let colorBuffer;
  let quadGeometryBuffer;
  
  const quadVertexCount = 6;

  // Component-specific shader code - much simpler now!
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
      
      // Rest of dots-specific positioning logic stays the same
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

  // Generate complete shader with centralized scale support
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

  // Update instance data using base renderer's buffer management
  function updateInstanceData(arrowTable) {
    try {
      if (!arrowTable || arrowTable.numRows === 0 || !renderer?.resourcesCreated) {
        console.debug('⚠️ Skipping dots instance data update - no data or resources not ready');
        return;
      }

      const device = webGPUContext.getDevice();
      if (!device) {
        throw new Error('No WebGPU device available');
      }

      const startTime = performance.now();
      const instanceCount = arrowTable.numRows;

      console.debug(`📊 Updating dots instance data for ${instanceCount} dots`);

      // Get Arrow columns with error checking
      const xColumn = arrowTable.getChild('x');
      const yColumn = arrowTable.getChild('y');
      const colorColumn = arrowTable.getChild('color');

      if (!xColumn || !yColumn) {
        throw new Error('Required x and y columns not found in Arrow table');
      }

      // Process data through BaseGPURenderer for proper scale handling
      const xValues = xColumn.toArray();
      const yValues = yColumn.toArray();
      
      // Use BaseGPURenderer's data processing for scale-aware conversion
      const xData = renderer.processDataForAxis(xValues, 'x');
      const yData = renderer.processDataForAxis(yValues, 'y');

      // Update position buffers using base renderer's smart buffer management
      xBuffer = renderer.createOrUpdateBuffer(xBuffer, xData);
      device.queue.writeBuffer(xBuffer, 0, xData);

      yBuffer = renderer.createOrUpdateBuffer(yBuffer, yData);
      device.queue.writeBuffer(yBuffer, 0, yData);

      // Create radius and alpha data
      const radiusData = new Float32Array(instanceCount);
      const alphaData = new Float32Array(instanceCount);
      
      if (typeof r === 'function' || typeof alpha === 'function') {
        for (let i = 0; i < instanceCount; i++) {
          radiusData[i] = typeof r === 'function' ? r({x: xValues[i], y: yValues[i]}) : r;
          alphaData[i] = typeof alpha === 'function' ? alpha({x: xValues[i], y: yValues[i]}) : alpha;
        }
      } else {
        radiusData.fill(r);
        alphaData.fill(alpha);
      }

      // Update attribute buffers
      radiusBuffer = renderer.createOrUpdateBuffer(radiusBuffer, radiusData);
      device.queue.writeBuffer(radiusBuffer, 0, radiusData);

      alphaBuffer = renderer.createOrUpdateBuffer(alphaBuffer, alphaData);
      device.queue.writeBuffer(alphaBuffer, 0, alphaData);

      // Handle colors with error checking
      const colorData = new Float32Array(instanceCount * 4);
      
      if (colorColumn) {
        const colorArray = colorColumn.toArray();
        for (let i = 0; i < instanceCount; i++) {
          const fillColor = colorScale(colorArray[i]);
          const rgba = renderer.parseColor(fillColor);
          colorData.set(rgba, i * 4);
        }
      } else {
        // Fallback to single color
        const rgba = renderer.parseColor(fill);
        for (let i = 0; i < instanceCount; i++) {
          colorData.set(rgba, i * 4);
        }
      }

      colorBuffer = renderer.createOrUpdateBuffer(colorBuffer, colorData);
      device.queue.writeBuffer(colorBuffer, 0, colorData);

      // Create bind group after all buffers are ready
      createDotsBindGroup();

      // Update instance count
      renderer.updateInstanceCount(instanceCount);

      const updateTime = performance.now() - startTime;
      console.debug(`✅ Dots instance data updated in ${updateTime.toFixed(2)}ms`);
      
    } catch (error) {
      console.error('❌ Failed to update dots instance data:', error);
      initializationError = error.message;
      throw error;
    }
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
    try {
      if (!renderer?.pipeline || !renderer?.bindGroup || renderer.instanceCount === 0) {
        console.debug('⚠️ Skipping dots draw - resources not ready or no instances');
        return;
      }

      passEncoder.setPipeline(renderer.pipeline);
      passEncoder.setBindGroup(0, renderer.bindGroup);
      passEncoder.setVertexBuffer(0, quadGeometryBuffer);
      passEncoder.draw(quadVertexCount, renderer.instanceCount);
      
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
      console.log('🚀 Initializing Dots component with centralized scale support');

      // Check GPU coordinator is available
      if (!gpuCoordinator) {
        throw new Error('GPU Coordinator context missing. Make sure setCoordinators() was called.');
      }

      // Create base renderer with scale type information
      renderer = new BaseGPURenderer('dots', webGPUContext, gpuCoordinator, c, { 
        zIndex,
        xScaleType: c.scaleTypes?.x || 'linear',
        yScaleType: c.scaleTypes?.y || 'linear'
      });

      // Initialize with dots-specific configuration using centralized shader
      await renderer.initialize({
        shaderCode, // This now includes universal scale support!
        vertexBufferLayout,
      });

      // Initialize dots-specific geometry
      await initializeDotsGeometry();

      // Update instance data if available
      if (data) {
        updateInstanceData(data);
      }
      
      // Register layer with base renderer
      renderer.registerLayer(drawDots);

      console.log('✅ Dots component initialized successfully with centralized scales');
      
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
    console.log('🧹 Cleaning up Dots component');
    
    try {
      // Clean up dots-specific resources
      if (quadGeometryBuffer && !quadGeometryBuffer.destroyed) {
        quadGeometryBuffer.destroy();
      }

      // Base renderer handles all other cleanup
      if (renderer) {
        renderer.destroy();
      }

      console.log('✅ Dots component cleanup complete');
      
    } catch (error) {
      console.error('❌ Error during Dots component cleanup:', error);
    }
  });

  // Enhanced reactive effect for data updates
  $effect(() => {
    void dataVersion;
    
    untrack(() => {
      if (renderer?.resourcesCreated && !initializationError && data) {
        try {
          updateInstanceData(data);
        } catch (error) {
          console.error('❌ Dots data update effect failed:', error);
          initializationError = error.message;
        }
      }
    });
  });

  // Reactive effect for scale changes - BaseGPURenderer handles the heavy lifting
  $effect(() => {
    if (!renderer) return;
    
    // Access scale properties to make this reactive
    const xScale = c?.xScale;
    const yScale = c?.yScale;
    
    // Track scale domains and ranges
    void xScale?.domain?.();
    void yScale?.domain?.();
    void xScale?.range?.();
    void yScale?.range?.();
    
    // Track band scale properties for completeness
    void xScale?.bandwidth?.();
    void yScale?.bandwidth?.();
    
    untrack(() => {
      renderer.handleScaleChange();
    });
  });

  // Reactive effect for resolution changes
  $effect(() => {
    if (!renderer) return;
    
    const { width, height } = webGPUContext.getCanvasDimensions();
    
    untrack(() => {
      renderer.handleResolutionChange();
    });
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