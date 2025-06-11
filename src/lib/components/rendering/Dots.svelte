<script>
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
  import { getScaleState } from '$lib/scales';

  let { 
    data, // This would be an Arrow Table
    dataVersion,
    r = 3,
    fill = 'blue',
    alpha = .5,
    zIndex = 0,
  } = $props();

  let colorScale = $derived(getScaleState('color', 'ordinal'));
  
  const c = getContext('chart');
  const webGPUContext = getContext('webgpu-canvas');

  // WebGPU resources
  let pipeline;
  let bindGroup;
  let resourcesCreated = false;

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
  
  let layerControl;
  let quadGeometryBuffer;
  const quadVertexCount = 6;

  let xDomain = $derived(c.xScale?.domain() ?? []);
  let yDomain = $derived(c.yScale?.domain() ?? []);
  let xRange = $derived(c.xScale?.range() ?? []);
  let yRange = $derived(c.yScale?.range() ?? []);

  const devicePixelRatio = window.devicePixelRatio || 1;

  // Updated shader to work with separate buffers
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

  async function createGPUResources(device) {
    const shaderModule = device.createShaderModule({
      code: shaderCode,
    });
    const msaaSampleCount = webGPUContext.getMsaaSampleCount();

    pipeline = device.createRenderPipeline({
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
      primitive: {
        topology: 'triangle-list',
      },
      multisample: {
        count: msaaSampleCount > 1 ? msaaSampleCount : 1  // Must be at least 1
      },
    });

    const quadVertices = createQuadGeometry();
    quadGeometryBuffer = device.createBuffer({
      size: quadVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(quadGeometryBuffer, 0, quadVertices);

    resolutionBuffer = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    dprBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const { width, height } = webGPUContext.getCanvasDimensions();
    device.queue.writeBuffer(resolutionBuffer, 0, new Float32Array([width, height]));
    device.queue.writeBuffer(dprBuffer, 0, new Float32Array([devicePixelRatio]));

    resourcesCreated = true;
  }

  function updateInstanceData(device, arrowTable) {
    const tsStartUpdate = Date.now();
    if (!arrowTable || arrowTable.numRows === 0 || !resourcesCreated) return;

    instanceCount = arrowTable.numRows;

    // Get Arrow columns
    const xColumn = arrowTable.getChild('x');
    const yColumn = arrowTable.getChild('y');
    const colorColumn = arrowTable.getChild('color');

    // Convert Float64Array to Float32Array
    const xData = new Float32Array(xColumn.toArray());
    const yData = new Float32Array(yColumn.toArray());

    // Create or update buffers with proper size and alignment
    function createOrUpdateBuffer(buffer, data, minSize = 16384) {
      const size = Math.max(data.byteLength, minSize);
      if (!buffer || buffer.size < size) {
        if (buffer) buffer.destroy();
        return device.createBuffer({
          size,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
      }
      return buffer;
    }

    // Update x buffer
    xBuffer = createOrUpdateBuffer(xBuffer, xData);
    device.queue.writeBuffer(xBuffer, 0, xData);

    // Update y buffer  
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

    // Update radius buffer
    radiusBuffer = createOrUpdateBuffer(radiusBuffer, radiusData);
    device.queue.writeBuffer(radiusBuffer, 0, radiusData);

    // Update alpha buffer
    alphaBuffer = createOrUpdateBuffer(alphaBuffer, alphaData);
    device.queue.writeBuffer(alphaBuffer, 0, alphaData);

    // Handle colors
    const colorData = new Float32Array(instanceCount * 4);
    const colorArray = colorColumn.toArray();
    
    for (let i = 0; i < instanceCount; i++) {
      const fillColor = colorScale(colorArray[i]);
      const rgba = parseColor(fillColor);
      colorData.set(rgba, i * 4);
    }

    colorBuffer = createOrUpdateBuffer(colorBuffer, colorData);
    device.queue.writeBuffer(colorBuffer, 0, colorData);

    // Create scale parameters buffer if it doesn't exist
    if (!scaleParamsBuffer) {
      scaleParamsBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    updateScaleParameters(device);

    // Create bind group only after all buffers are ready
    if (!bindGroup) {
      createBindGroup(device);
    }
  }

  function createBindGroup(device) {
    // Make sure all buffers exist before creating bind group
    if (!xBuffer || !yBuffer || !radiusBuffer || !alphaBuffer || !colorBuffer || !scaleParamsBuffer || !resolutionBuffer || !dprBuffer || !pipeline) {
      console.warn('Not all buffers are ready for bind group creation');
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
  }

  function updateScaleParameters(device) {
    if (!scaleParamsBuffer) return;

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
  }

  function draw(passEncoder, device, presentationFormat) {
    if (!pipeline || !bindGroup || instanceCount === 0) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, quadGeometryBuffer);
    passEncoder.draw(quadVertexCount, instanceCount);
  }

  function parseColor(color) {
    if (color.startsWith('#')) {
      const r = parseInt(color.slice(1, 3), 16) / 255;
      const g = parseInt(color.slice(3, 5), 16) / 255;
      const b = parseInt(color.slice(5, 7), 16) / 255;
      return [r, g, b, 1.0];
    }
    return [0.0, 0.0, 1.0, 1.0];
  }

  async function initialize() {
    const device = webGPUContext.getDevice();
    if (device) {
      await createGPUResources(device);
      updateInstanceData(device, data);
      
      // Register this component as a WebGPU layer
      layerControl = webGPUContext.registerLayer({
        zIndex,
        draw,
        visible: true
      });
    }
  }

  // Wait for WebGPU to be initialized before setting up resources
  async function waitForWebGPU() {
    while (!webGPUContext.isInitialized()) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await initialize();
  }

  onMount(async () => {
    await waitForWebGPU();
  });

  onDestroy(() => {
    // Clean up WebGPU resources
    if (quadGeometryBuffer) quadGeometryBuffer.destroy();
    if (xBuffer) xBuffer.destroy();
    if (yBuffer) yBuffer.destroy();
    if (radiusBuffer) radiusBuffer.destroy();
    if (alphaBuffer) alphaBuffer.destroy();
    if (colorBuffer) colorBuffer.destroy();
    if (scaleParamsBuffer) scaleParamsBuffer.destroy();
    if (resolutionBuffer) resolutionBuffer.destroy();
    if (dprBuffer) dprBuffer.destroy();
    
    // Clean up layer
    if (layerControl) {
      layerControl.remove();
    }
  });

  // Update instance data when dataVersion changes;
  $effect(() => {
    void dataVersion;
    
    untrack(() => {
      const device = webGPUContext.getDevice();
      if (device && layerControl && resourcesCreated) {
        updateInstanceData(device, data);
        layerControl.invalidate();
      }
    });
  });

  // Update the scale change effect to only update scale parameters
  $effect(() => {
    void xDomain, yDomain, xRange, yRange;
    const device = webGPUContext.getDevice();
    if (device && layerControl && resourcesCreated && scaleParamsBuffer) {
      // Only update scale parameters, not the entire bind group
      updateScaleParameters(device);
      layerControl.invalidate();
    }
  });

  // Update resolution when canvas size changes
  $effect(() => {
    // Trigger on width and height changes from the chart context
    // void c.innerWidth;
    // void c.innerHeight;
    const { width, height } = webGPUContext.getCanvasDimensions();
    const device = webGPUContext.getDevice();
    if (resolutionBuffer && device && layerControl && resourcesCreated) {
      device.queue.writeBuffer(resolutionBuffer, 0, new Float32Array([width, height]));
      // layerControl.invalidate();
      // console.log('resolution buffer updated')
    }
  });
</script>