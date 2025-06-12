<script>
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
  import { getScaleState } from '$lib/scales';
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

  // Enhanced resource tracking for proper cleanup
  let ownedResources = {
    pipeline: false,
    shader: false,
    buffers: [],
    layerControl: null
  };

  // WebGPU resources
  let pipeline;
  let bindGroup;
  let resourcesCreated = false;
  let initializationError = $state(null);

  // Separate buffers for Arrow columns
  let xBuffer;
  let yBuffer;
  let radiusBuffer;
  let alphaBuffer;
  let colorBuffer;
  let scaleParamsBuffer;
  let resolutionBuffer;
  let dprBuffer;
  let instanceCount = 0;
  
  let quadGeometryBuffer;
  const quadVertexCount = 6;

  // Derived reactive state
  let xDomain = $derived(c.xScale?.domain() ?? []);
  let yDomain = $derived(c.yScale?.domain() ?? []);
  let xRange = $derived(c.xScale?.range() ?? []);
  let yRange = $derived(c.yScale?.range() ?? []);

  const devicePixelRatio = window.devicePixelRatio || 1;

  // Enhanced shader with better structure and comments
  const shaderCode = `
    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec4<f32>,
      @location(1) uv: vec2<f32>,
      @location(2) radius: f32,
      @location(3) alpha: f32,
    };

    struct ScaleParams {
      domainMin: vec2<f32>,
      domainMax: vec2<f32>,
      rangeMin: vec2<f32>,
      rangeMax: vec2<f32>,
    };

    @group(0) @binding(0) var<uniform> resolution: vec2<f32>;
    @group(0) @binding(1) var<storage, read> xValues: array<f32>;
    @group(0) @binding(2) var<storage, read> yValues: array<f32>;
    @group(0) @binding(3) var<storage, read> radiusValues: array<f32>;
    @group(0) @binding(4) var<storage, read> alphaValues: array<f32>;
    @group(0) @binding(5) var<storage, read> colors: array<vec4<f32>>;
    @group(0) @binding(6) var<uniform> scaleParams: ScaleParams;
    @group(0) @binding(7) var<uniform> devicePixelRatio: f32;
    
    fn scaleValue(value: f32, domainMin: f32, domainMax: f32, rangeMin: f32, rangeMax: f32) -> f32 {
      let normalized = (value - domainMin) / (domainMax - domainMin);
      return rangeMin + normalized * (rangeMax - rangeMin);
    }
    
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
      
      // Apply scales on GPU
      let scaledX = scaleValue(x, scaleParams.domainMin.x, scaleParams.domainMax.x, 
                               scaleParams.rangeMin.x, scaleParams.rangeMax.x);
      let scaledY = scaleValue(y, scaleParams.domainMin.y, scaleParams.domainMax.y, 
                               scaleParams.rangeMin.y, scaleParams.rangeMax.y);
      
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

  // Enhanced resource creation with proper sharing and error handling
  async function createGPUResources(device) {
    try {
      console.log('🔧 Creating GPU resources for Dots component');
      
      if (!gpuCoordinator) {
        throw new Error('GPU coordinator not available');
      }

      // Create or get shared shader with reference counting
      const shaderModule = await gpuCoordinator.getOrCreateSharedShader('dots', shaderCode);
      ownedResources.shader = true;

      // Create or get shared pipeline with proper lifecycle
      pipeline = await gpuCoordinator.getOrCreateSharedPipeline('dots', async () => {
        const msaaSampleCount = webGPUContext.getMsaaSampleCount();

        return device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: shaderModule,
            entryPoint: 'vertexMain',
            buffers: [{
              arrayStride: 2 * 4,
              attributes: [{
                shaderLocation: 0,
                offset: 0,
                format: 'float32x2',
              }],
            }],
          },
          fragment: {
            module: shaderModule,
            entryPoint: 'fragmentMain',
            targets: [{
              format: webGPUContext.getPresentationFormat(),
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
      });
      ownedResources.pipeline = true;

      // Create quad geometry buffer
      const quadVertices = createQuadGeometry();
      quadGeometryBuffer = device.createBuffer({
        size: quadVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(quadGeometryBuffer, 0, quadVertices);
      ownedResources.buffers.push(quadGeometryBuffer);

      // Create chart-specific uniform buffers
      resolutionBuffer = device.createBuffer({
        size: 8,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      ownedResources.buffers.push(resolutionBuffer);

      // Use shared DPR buffer if available, create own if needed
      dprBuffer = gpuCoordinator?.getSharedUniformBuffer('devicePixelRatio');
      
      if (!dprBuffer) {
        console.warn('🔶 Creating own DPR buffer - coordinator should provide this');
        dprBuffer = device.createBuffer({
          size: 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(dprBuffer, 0, new Float32Array([devicePixelRatio]));
        ownedResources.buffers.push(dprBuffer);
      }

      // Update initial values
      const { width, height } = webGPUContext.getCanvasDimensions();
      device.queue.writeBuffer(resolutionBuffer, 0, new Float32Array([width, height]));

      resourcesCreated = true;
      console.log('✅ GPU resources created successfully for Dots component');
      
    } catch (error) {
      console.error('❌ Failed to create GPU resources for Dots component:', error);
      initializationError = error.message;
      throw error;
    }
  }

  // Enhanced buffer management with smart sizing and reuse
  function createOrUpdateBuffer(existingBuffer, data, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) {
    const device = webGPUContext.getDevice();
    if (!device) {
      throw new Error('No WebGPU device available');
    }
    
    const requiredSize = data.byteLength;
    
    // Only recreate if actually needed, with smart sizing strategy
    if (!existingBuffer || existingBuffer.size < requiredSize) {
      if (existingBuffer) {
        // Remove from tracking before destroying
        const index = ownedResources.buffers.indexOf(existingBuffer);
        if (index !== -1) {
          ownedResources.buffers.splice(index, 1);
        }
        existingBuffer.destroy();
      }

      // Smart buffer sizing - avoid frequent reallocations
      const bufferSize = Math.max(
        requiredSize,
        Math.ceil(requiredSize * 1.5), // 50% headroom for growth
        4096 // Minimum reasonable size
      );

      const newBuffer = device.createBuffer({
        size: bufferSize,
        usage,
      });
      
      ownedResources.buffers.push(newBuffer);
      console.debug(`📊 Created buffer of size ${bufferSize} bytes (required: ${requiredSize})`);
      return newBuffer;
    }
    
    return existingBuffer;
  }

  // Enhanced instance data management with better error handling
  function updateInstanceData(device, arrowTable) {
    try {
      if (!arrowTable || arrowTable.numRows === 0 || !resourcesCreated) {
        console.debug('⚠️ Skipping instance data update - no data or resources not ready');
        return;
      }

      const startTime = performance.now();
      instanceCount = arrowTable.numRows;

      console.debug(`📊 Updating instance data for ${instanceCount} dots`);

      // Get Arrow columns with error checking
      const xColumn = arrowTable.getChild('x');
      const yColumn = arrowTable.getChild('y');
      const colorColumn = arrowTable.getChild('color');

      if (!xColumn || !yColumn) {
        throw new Error('Required x and y columns not found in Arrow table');
      }

      // Convert data with type safety
      const xData = new Float32Array(xColumn.toArray());
      const yData = new Float32Array(yColumn.toArray());

      // Update position buffers
      xBuffer = createOrUpdateBuffer(xBuffer, xData);
      device.queue.writeBuffer(xBuffer, 0, xData);

      yBuffer = createOrUpdateBuffer(yBuffer, yData);
      device.queue.writeBuffer(yBuffer, 0, yData);

      // Create radius and alpha data
      const radiusData = new Float32Array(instanceCount);
      const alphaData = new Float32Array(instanceCount);
      
      if (typeof r === 'function' || typeof alpha === 'function') {
        for (let i = 0; i < instanceCount; i++) {
          radiusData[i] = typeof r === 'function' ? r({x: xData[i], y: yData[i]}) : r;
          alphaData[i] = typeof alpha === 'function' ? alpha({x: xData[i], y: yData[i]}) : alpha;
        }
      } else {
        radiusData.fill(r);
        alphaData.fill(alpha);
      }

      // Update attribute buffers
      radiusBuffer = createOrUpdateBuffer(radiusBuffer, radiusData);
      device.queue.writeBuffer(radiusBuffer, 0, radiusData);

      alphaBuffer = createOrUpdateBuffer(alphaBuffer, alphaData);
      device.queue.writeBuffer(alphaBuffer, 0, alphaData);

      // Handle colors with error checking
      const colorData = new Float32Array(instanceCount * 4);
      
      if (colorColumn) {
        const colorArray = colorColumn.toArray();
        for (let i = 0; i < instanceCount; i++) {
          const fillColor = colorScale(colorArray[i]);
          const rgba = parseColor(fillColor);
          colorData.set(rgba, i * 4);
        }
      } else {
        // Fallback to single color
        const rgba = parseColor(fill);
        for (let i = 0; i < instanceCount; i++) {
          colorData.set(rgba, i * 4);
        }
      }

      colorBuffer = createOrUpdateBuffer(colorBuffer, colorData);
      device.queue.writeBuffer(colorBuffer, 0, colorData);

      // Create scale parameters buffer if needed
      if (!scaleParamsBuffer) {
        scaleParamsBuffer = device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        ownedResources.buffers.push(scaleParamsBuffer);
      }
      
      updateScaleParameters(device);

      // Create bind group after all buffers are ready
      if (!bindGroup) {
        createBindGroup(device);
      }

      const updateTime = performance.now() - startTime;
      console.debug(`✅ Instance data updated in ${updateTime.toFixed(2)}ms`);
      
    } catch (error) {
      console.error('❌ Failed to update instance data:', error);
      initializationError = error.message;
      throw error;
    }
  }

  // Enhanced bind group creation with comprehensive validation
  function createBindGroup(device) {
    try {
      // Comprehensive validation of all required resources
      const requiredBuffers = {
        resolutionBuffer,
        xBuffer,
        yBuffer,
        radiusBuffer,
        alphaBuffer,
        colorBuffer,
        scaleParamsBuffer,
        dprBuffer
      };

      const missingBuffers = Object.entries(requiredBuffers)
        .filter(([name, buffer]) => !buffer)
        .map(([name]) => name);

      if (missingBuffers.length > 0 || !pipeline) {
        console.warn(`⚠️ Cannot create bind group - missing resources: ${missingBuffers.join(', ')}${!pipeline ? ', pipeline' : ''}`);
        return;
      }

      bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: resolutionBuffer } },
          { binding: 1, resource: { buffer: xBuffer } },
          { binding: 2, resource: { buffer: yBuffer } },
          { binding: 3, resource: { buffer: radiusBuffer } },
          { binding: 4, resource: { buffer: alphaBuffer } },
          { binding: 5, resource: { buffer: colorBuffer } },
          { binding: 6, resource: { buffer: scaleParamsBuffer } },
          { binding: 7, resource: { buffer: dprBuffer } },
        ],
      });

      console.debug('✅ Bind group created successfully');
      
    } catch (error) {
      console.error('❌ Failed to create bind group:', error);
      initializationError = error.message;
      throw error;
    }
  }

  // Enhanced scale parameter updates
  function updateScaleParameters(device) {
    if (!scaleParamsBuffer) {
      console.warn('⚠️ Cannot update scale parameters - buffer not available');
      return;
    }

    try {
      const scaleParams = new Float32Array(8);
      scaleParams[0] = xDomain[0] ?? 0;
      scaleParams[1] = yDomain[0] ?? 0;
      scaleParams[2] = xDomain[1] ?? 1;
      scaleParams[3] = yDomain[1] ?? 1;
      scaleParams[4] = xRange[0] ?? 0;
      scaleParams[5] = yRange[0] ?? 0;
      scaleParams[6] = xRange[1] ?? 1;
      scaleParams[7] = yRange[1] ?? 1;

      device.queue.writeBuffer(scaleParamsBuffer, 0, scaleParams);
      
    } catch (error) {
      console.error('❌ Failed to update scale parameters:', error);
    }
  }

  // Enhanced draw function with comprehensive error handling
  function draw(passEncoder, device, presentationFormat) {
    try {
      if (!pipeline || !bindGroup || instanceCount === 0) {
        console.debug('⚠️ Skipping draw - resources not ready or no instances');
        return;
      }

      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.setVertexBuffer(0, quadGeometryBuffer);
      passEncoder.draw(quadVertexCount, instanceCount);
      
    } catch (error) {
      console.error('❌ Draw operation failed:', error);
      throw error;
    }
  }

  // Enhanced color parsing with better error handling
  function parseColor(color) {
    try {
      if (typeof color === 'string' && color.startsWith('#')) {
        const r = parseInt(color.slice(1, 3), 16) / 255;
        const g = parseInt(color.slice(3, 5), 16) / 255;
        const b = parseInt(color.slice(5, 7), 16) / 255;
        return [r, g, b, 1.0];
      }
      // Add support for other color formats if needed
      console.warn(`⚠️ Unrecognized color format: ${color}, using default blue`);
      return [0.0, 0.0, 1.0, 1.0];
    } catch (error) {
      console.error('❌ Color parsing failed:', error);
      return [0.0, 0.0, 1.0, 1.0];
    }
  }

  // Enhanced initialization with comprehensive error handling
  async function initialize() {
    try {
      console.log('🚀 Initializing Dots component');
      
      const device = webGPUContext.getDevice();
      if (!device) {
        throw new Error('No WebGPU device available from context');
      }

      await createGPUResources(device);
      updateInstanceData(device, data);
      
      // Register layer with enhanced metadata
      ownedResources.layerControl = webGPUContext.registerLayer({
        zIndex,
        draw,
        visible: true,
        markType: 'dots',
        componentId: `dots-${crypto.randomUUID().slice(0, 6)}`
      });

      console.log('✅ Dots component initialized successfully');
      
    } catch (error) {
      console.error('❌ Dots component initialization failed:', error);
      initializationError = error.message;
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
    
    await initialize();
  }

  onMount(async () => {
    try {
      await waitForWebGPU();
    } catch (error) {
      console.error('❌ Dots component mount failed:', error);
      initializationError = error.message;
    }
  });

  // Comprehensive cleanup with resource tracking
  onDestroy(() => {
    console.log('🧹 Cleaning up Dots component resources');
    
    try {
      // Clean up chart-specific buffers
      ownedResources.buffers.forEach(buffer => {
        if (buffer && !buffer.destroyed) {
          buffer.destroy();
        }
      });
      ownedResources.buffers = [];

      // Release shared resource references
      if (ownedResources.pipeline && gpuCoordinator) {
        gpuCoordinator.releaseSharedPipeline('dots');
      }
      
      if (ownedResources.shader && gpuCoordinator) {
        gpuCoordinator.releaseSharedShader('dots');
      }

      // Release shared uniform buffer reference
      if (dprBuffer && !ownedResources.buffers.includes(dprBuffer) && gpuCoordinator) {
        gpuCoordinator.releaseSharedUniformBuffer('devicePixelRatio');
      }

      // Clean up layer registration
      if (ownedResources.layerControl) {
        ownedResources.layerControl.remove();
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
      const device = webGPUContext.getDevice();
      if (device && ownedResources.layerControl && resourcesCreated && !initializationError) {
        try {
          updateInstanceData(device, data);
          ownedResources.layerControl.invalidate();
        } catch (error) {
          console.error('❌ Data update effect failed:', error);
          initializationError = error.message;
        }
      }
    });
  });

  // Enhanced reactive effect for scale changes
  $effect(() => {
    void xDomain, yDomain, xRange, yRange;
    
    const device = webGPUContext.getDevice();
    if (device && ownedResources.layerControl && resourcesCreated && scaleParamsBuffer && !initializationError) {
      try {
        updateScaleParameters(device);
        ownedResources.layerControl.invalidate();
      } catch (error) {
        console.error('❌ Scale update effect failed:', error);
      }
    }
  });

  // Enhanced reactive effect for resolution changes
  $effect(() => {
    const { width, height } = webGPUContext.getCanvasDimensions();
    const device = webGPUContext.getDevice();
    
    if (resolutionBuffer && device && ownedResources.layerControl && resourcesCreated && !initializationError) {
      try {
        device.queue.writeBuffer(resolutionBuffer, 0, new Float32Array([width, height]));
        // Note: Don't invalidate for resolution changes to avoid unnecessary redraws
      } catch (error) {
        console.error('❌ Resolution update effect failed:', error);
      }
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