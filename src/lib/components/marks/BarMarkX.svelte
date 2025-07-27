<script>
  import { getContext, onDestroy, untrack } from 'svelte';
  import { getScaleState } from '$lib/scales';
  import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
  import { Rects } from '../rendering/index.js';
  import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
  import { processData, buildSelectFromChannels } from './utils/index.js';

  let { 
    table, 
    selection, 
    x,           // shorthand for x2
    x1 = 0,      // baseline (start of bars)
    x2 = x,      // end of bars (the data values)
    y,           // categorical data
    color, 
    alpha = 0.8,
    limit,
    filterNulls = false,
  } = $props();

  const markId = `barx-${crypto.randomUUID().slice(0, 8)}`;

  const coordinator = getContext('mosaic-coordinator');
  const chartContext = getContext('chart');
  const colorScale = $derived(getScaleState('color', 'ordinal'));

  let setup = $state(null);
  let xScaleId = $derived(chartContext.xScaleState?.id);
  let yScaleId = $derived(chartContext.yScaleState?.id);

  const config = $derived({
    markType: 'barx',
    supportedScaleTypes: {
      x: ['linear', 'identity'],           // continuous only
      y: ['band']                          // categorical only
    },
    scaleRequirements: {
      x: { type: 'linear', priority: SCALE_PRIORITIES.PREFER },
      y: { type: 'band', priority: SCALE_PRIORITIES.MANDATE }
    },
    table,
    selection,
    select: buildSelectFromChannels({ x1, x2, y, color }),
    clientOptions: {
      limit,
      filterNulls: filterNulls ? [x1, x2, y] : null
    }
  });

  // Data processing
  let arrowTable = $derived(setup?.client?.arrowTable);
  let instanceCount = $derived(arrowTable?.numRows || 0);

  // Get Arrow columns (only for SQL expressions)
  let x1Column = $derived(arrowTable?.getChild('x1'));
  let x2Column = $derived(arrowTable?.getChild('x2')); 
  let yColumn = $derived(arrowTable?.getChild('y'));
  let colorColumn = $derived(arrowTable?.getChild('color'));

  // Process x data using utility functions
  let x0Data = $derived.by(() => {
    if (!instanceCount) return null;
    return processData(x1, x1Column, instanceCount);
  });

  let x1Data = $derived.by(() => {
    if (!instanceCount) return null;
    return processData(x2, x2Column, instanceCount);
  });

  // Process categorical y data through band scale
  let yData = $derived.by(() => {
    if (!instanceCount || !yColumn || !setup?.actualYScaleType) return null;
    
    if (setup.actualYScaleType === 'band') {
      const rawArray = yColumn.toArray();
      const indices = chartContext.yScaleState.processDataForGPU(rawArray, setup.markId);
      
      // Convert indices to rectangle coordinates
      const y0Data = new Float32Array(instanceCount);
      const y1Data = new Float32Array(instanceCount);
      
      for (let i = 0; i < instanceCount; i++) {
        const categoryIndex = indices[i];
        // Each category spans from index to index+1 in band scale space
        y0Data[i] = categoryIndex;
        y1Data[i] = categoryIndex + 1;
      }
      
      return { y0Data, y1Data };
    }
    
    return null;
  });

  let y0Data = $derived(yData?.y0Data);
  let y1Data = $derived(yData?.y1Data);

  // Color processing (same as dots)
  let colorData = $derived.by(() => {
    if (!colorColumn || !instanceCount || !colorScale) return null;
    
    const colorArray = colorColumn.toArray();
    const rgba = new Float32Array(instanceCount * 4);
    
    for (let i = 0; i < instanceCount; i++) {
      const colorValue = colorArray[i];
      const fillColor = colorScale(colorValue);
      const parsed = parseColor(fillColor);
      rgba.set(parsed, i * 4);
    }
    
    return rgba;
  });

  // Alpha processing
  let alphaData = $derived.by(() => {
    if (!instanceCount) return null;
    const alphas = new Float32Array(instanceCount);
    alphas.fill(alpha);
    return alphas;
  });

  // Helper function for color parsing
  function parseColor(color) {
    if (typeof color === 'string' && color.startsWith('#')) {
      const r = parseInt(color.slice(1, 3), 16) / 255;
      const g = parseInt(color.slice(3, 5), 16) / 255;
      const b = parseInt(color.slice(5, 7), 16) / 255;
      return [r, g, b, 1.0];
    }
    return [0.0, 0.0, 1.0, 1.0]; // Default blue
  }

  // Setup effect
  $effect(() => {
    console.log('barx setup effect');
    void config, xScaleId, yScaleId;
    
    untrack(() => {
      setup?.destroy();
      
      setup = new BaseMarkSetup(
        config,
        coordinator,
        chartContext,
        markId
      );
    });
  });

  onDestroy(() => {
    setup?.destroy();
  });

  $inspect(x0Data, x1Data, y0Data, y1Data)
</script>

{#if setup?.gpuReady && x0Data && x1Data && y0Data && y1Data}
  <Rects
    {x0Data}
    x1Data={x1Data}
    {y0Data}
    {y1Data}
    {colorData}
    {alphaData}
    dataVersion={setup.client.dataVersion}
  />
{:else if setup?.client?.error}
  <text x={chartContext.margin.left} y={chartContext.margin.top} fill="red" font-size="12">
    Error: {setup.client.error.message}
  </text>
{:else if setup?.client?.delayedLoading}
  <text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
    Loading data...
  </text>
{:else}
  <text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
    Initializing bars...
  </text>
{/if}