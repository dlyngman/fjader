<script>
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
  import { BaseGPURenderer } from './BaseGPURenderer.svelte.js';
  import { getGPUContext } from '$lib/gpu';
  import { getScaleState } from '$lib/scales';

  // --- COMPONENT API ---
  let {
    data,           // Required: Arrow Table
    dataVersion,    // Required: A number that changes when data is updated
    x0Column = 'x0',
    x1Column = 'x1',
    y0Column = 'y0',
    y1Column = 'y1',
    colorColumn = null,
    fill = 'steelblue',
    alpha = 0.8,
    zIndex = 0,
  } = $props();

  // --- CONTEXTS & STATE ---
  const chartContext = getContext('chart');
  const webGPUContext = getContext('webgpu-canvas');
  const gpuCoordinator = getGPUContext();
  const colorScale = $derived(getScaleState('color', 'ordinal'));

  let renderer = $state(null);
  let initializationError = $state(null);

  // --- GPU BUFFERS ---
  let x0_buffer, x1_buffer, y0_buffer, y1_buffer, color_buffer;
  let rectGeometryBuffer; // For the static vertex corners
  const rectVertexCount = 6;

  // --- SHADER DEFINITION ---
  const rectsShaderCode = BaseGPURenderer.generateShader(`
    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec4<f32>
    };

    // Bindings 1-5 are for our specific rect data
    @group(0) @binding(1) var<storage, read> x0_values: array<f32>;
    @group(0) @binding(2) var<storage, read> x1_values: array<f32>;
    @group(0) @binding(3) var<storage, read> y0_values: array<f32>;
    @group(0) @binding(4) var<storage, read> y1_values: array<f32>;
    @group(0) @binding(5) var<storage, read> color_values: array<vec4<f32>>;
    
    @vertex
    fn vertexMain(
      @location(0) rectCorner: vec2<f32>, // A corner of a unit square (0,0 to 1,1)
      @builtin(instance_index) instanceIdx: u32,
    ) -> VertexOutput {
      // Get the four corner data values for this instance
      let x0 = x0_values[instanceIdx];
      let x1 = x1_values[instanceIdx];
      let y0 = y0_values[instanceIdx];
      let y1 = y1_values[instanceIdx];

      // Scale them using the universal scaling functions from BaseGPURenderer
      let sx0 = scaleX(x0, scaleParams);
      let sx1 = scaleX(x1, scaleParams);
      let sy0 = scaleY(y0, scaleParams);
      let sy1 = scaleY(y1, scaleParams);

      // Use mix() to interpolate between the scaled corners
      let finalX = mix(sx0, sx1, rectCorner.x);
      let finalY = mix(sy0, sy1, rectCorner.y);

      // Convert to normalized device coordinates
      let worldPos = vec2<f32>(finalX, finalY);
      let normalizedPos = (worldPos / resolution) * 2.0 - 1.0;
      
      var output: VertexOutput;
      output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
      output.color = vec4<f32>(color_values[instanceIdx].rgb, ${alpha});
      return output;
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
      return input.color;
    }
  `);

  // --- DATA PROCESSING (with cache) ---

  // Use `$derived.by` for pure data processing. This runs only when its dependencies change.
  let processedData = $derived.by(() => {
    if (!renderer?.resourcesCreated || !data) return null;

    // 🎯 Cache is created here, exists only for this single execution.
    const cache = new Map();

    // Helper to process a column, using the cache to avoid re-work.
    const getProcessedColumn = (columnName, axis) => {
      if (!columnName || !data.getChild(columnName)) return null;
      const key = `${columnName}_${axis}`;
      if (!cache.has(key)) {
        const rawData = data.getChild(columnName).toArray();
        cache.set(key, renderer.processDataForAxis(rawData, axis));
        // console.log(`[Rects] Cache MISS for: ${key}`);
      } else {
        // console.log(`[Rects] Cache HIT for: ${key}`);
      }
      return cache.get(key);
    };
    
    const processColorData = () => {
      const instanceCount = data.numRows;
      const colorData = new Float32Array(instanceCount * 4);
      const colorCol = colorColumn ? data.getChild(colorColumn)?.toArray() : null;
      if (colorCol) {
          for (let i = 0; i < instanceCount; i++) {
              const c = renderer.parseColor(colorScale(colorCol[i]));
              colorData.set(c, i * 4);
          }
      } else {
          const c = renderer.parseColor(fill);
          for (let i = 0; i < instanceCount; i++) {
              colorData.set(c, i * 4);
          }
      }
      return colorData;
    };

    return {
      x0: getProcessedColumn(x0Column, 'x'),
      x1: getProcessedColumn(x1Column, 'x'),
      y0: getProcessedColumn(y0Column, 'y'),
      y1: getProcessedColumn(y1Column, 'y'),
      color: processColorData()
    };
  });

  // --- GPU SIDE-EFFECTS ---

  // This `$effect` handles the side-effect of writing data to the GPU.
  // It runs ONLY when the `processedData` object itself changes.
  $effect(() => {
    if (processedData) {
      untrack(() => { // Prevent tracking dependencies inside this side-effect
        updateGpuBuffers(processedData);
      });
    }
  });

  function updateGpuBuffers(pData) {
    const device = gpuCoordinator.device;
    if (!device || !renderer || !pData.x0) return;

    // Create or update GPU buffers for the five data channels
    x0_buffer = renderer.createOrUpdateBuffer(x0_buffer, pData.x0);
    x1_buffer = renderer.createOrUpdateBuffer(x1_buffer, pData.x1);
    y0_buffer = renderer.createOrUpdateBuffer(y0_buffer, pData.y0);
    y1_buffer = renderer.createOrUpdateBuffer(y1_buffer, pData.y1);
    color_buffer = renderer.createOrUpdateBuffer(color_buffer, pData.color);
    
    // Write data to the GPU
    device.queue.writeBuffer(x0_buffer, 0, pData.x0);
    device.queue.writeBuffer(x1_buffer, 0, pData.x1);
    device.queue.writeBuffer(y0_buffer, 0, pData.y0);
    device.queue.writeBuffer(y1_buffer, 0, pData.y1);
    device.queue.writeBuffer(color_buffer, 0, pData.color);
    
    // Finalize the setup for this frame
    createRectsBindGroup();
    renderer.updateInstanceCount(data.numRows);
    renderer.invalidateLayer();
  }

  // --- RENDERER SETUP & LIFECYCYCLE ---

  const vertexBufferLayout = [{
    arrayStride: 2 * 4, // 2 floats * 4 bytes
    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
  }];

  function createRectGeometry() {
    const device = webGPUContext.getDevice();
    const vertices = new Float32Array([
        0, 0,  // Corresponds to (x0, y0)
        1, 0,  // Corresponds to (x1, y0)
        0, 1,  // Corresponds to (x0, y1)
        1, 0,  // Corresponds to (x1, y0)
        1, 1,  // Corresponds to (x1, y1)
        0, 1,  // Corresponds to (x0, y1)
    ]);
    rectGeometryBuffer = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(rectGeometryBuffer, 0, vertices);
  }

  function createRectsBindGroup() {
    if (!x0_buffer || !x1_buffer || !y0_buffer || !y1_buffer || !color_buffer) return;
    const rectsBindings = [
      { binding: 1, resource: { buffer: x0_buffer } },
      { binding: 2, resource: { buffer: x1_buffer } },
      { binding: 3, resource: { buffer: y0_buffer } },
      { binding: 4, resource: { buffer: y1_buffer } },
      { binding: 5, resource: { buffer: color_buffer } },
    ];
    renderer.createBindGroup(rectsBindings);
  }

  function drawRects(passEncoder) {
    if (!renderer?.pipeline || !renderer?.bindGroup || renderer.instanceCount === 0) return;
    passEncoder.setPipeline(renderer.pipeline);
    passEncoder.setBindGroup(0, renderer.bindGroup);
    passEncoder.setVertexBuffer(0, rectGeometryBuffer);
    passEncoder.draw(rectVertexCount, renderer.instanceCount);
  }

  onMount(() => {
    try {
      renderer = new BaseGPURenderer('rects', webGPUContext, gpuCoordinator, chartContext, { 
        zIndex,
        xScaleType: chartContext.scaleTypes?.x || 'linear',
        yScaleType: chartContext.scaleTypes?.y || 'linear'
      });
      renderer.initialize({ shaderCode: rectsShaderCode, vertexBufferLayout });
      createRectGeometry();
      renderer.registerLayer(drawRects);
    } catch (error) {
      console.error('Rects component initialization failed:', error);
      initializationError = error.message;
    }
  });

  onDestroy(() => {
    renderer?.destroy();
    if (rectGeometryBuffer && !rectGeometryBuffer.destroyed) {
      rectGeometryBuffer.destroy();
    }
  });

  // --- REACTIVE EFFECTS FOR SCALE/LAYOUT CHANGES ---
  $effect(() => {
    if (!renderer) return;
    void chartContext.xScaleState?.domain?.current, chartContext.yScaleState?.domain?.current;
    untrack(() => renderer.handleScaleOrRangeUpdate());
  });

  $effect(() => {
    if (!renderer) return;
    void chartContext.innerWidth, chartContext.innerHeight;
    untrack(() => renderer.handleResolutionChange());
  });

</script>

{#if initializationError}
  <div class="rects-error">
    <p>Rects Renderer Error:</p>
    <p class="error-message">{initializationError}</p>
  </div>
{/if}

<style>
  .rects-error {
    position: absolute;
    top: 10px; left: 10px;
    background-color: rgba(255, 240, 240, 0.9);
    border: 1px solid #ffcccb;
    border-radius: 4px;
    padding: 8px 12px;
    font-size: 12px;
    color: #d32f2f;
    z-index: 1000;
  }
  .error-message {
    font-family: monospace;
    font-size: 11px;
  }
</style>