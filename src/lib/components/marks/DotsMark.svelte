<script>
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
  import { getScaleState } from '$lib/scales';
  import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
  import { Dots } from '../rendering/index.js';
  import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';

  let { 
    table, 
    selection, 
    x, 
    y, 
    color, 
    alpha = 0.5, 
    radius = 3,
    limit,
    filterNulls = false,
    preferredXScaleType = 'linear', 
    preferredYScaleType = 'linear',
  } = $props();

  const markId = `dot-${crypto.randomUUID().slice(0, 8)}`;

  const coordinator = getContext('mosaic-coordinator');
  const chartContext = getContext('chart');
  const colorScale = $derived(getScaleState('color', 'ordinal'));

  let setup = $state(null);
  let xScaleId = $derived(chartContext.xScaleState?.id);
  let yScaleId = $derived(chartContext.yScaleState?.id);

  const config = $derived({
    markType: 'dot',
    supportedScaleTypes: {
      x: ['linear', 'identity', 'band', 'point', 'time', 'log'],
      y: ['linear', 'identity', 'band', 'point', 'time', 'log']
    },
    scaleRequirements: {
      x: { type: preferredXScaleType, priority: SCALE_PRIORITIES.PREFER },
      y: { type: preferredYScaleType, priority: SCALE_PRIORITIES.PREFER }
    },
    table,
    selection,
    select: { x, y, ...(color && { color }) },
    clientOptions: {
      limit,
      filterNulls: filterNulls ? [x, y] : null
    }
  })

  let arrowTable = $derived(setup?.client?.arrowTable);
  let instanceCount = $derived(arrowTable?.numRows || 0);

  let xColumn = $derived(arrowTable?.getChild('x'));
  let yColumn = $derived(arrowTable?.getChild('y')); 
  let colorColumn = $derived(arrowTable?.getChild('color'));

  let xData = $derived.by(() => {
    if (!xColumn || !setup?.actualXScaleType) return null;
    
    const rawArray = xColumn.toArray(); // Zero-copy Arrow extraction
    
    // Scale-aware processing
    if (setup.actualXScaleType === 'band' || setup.actualXScaleType === 'point') {
      return chartContext.xScaleState.processDataForGPU(rawArray, setup.markId);
    } else {
      if (rawArray instanceof Float32Array) {
        return rawArray;
      } else {
        return new Float32Array(rawArray); // Copy only when necessary
      }
    }
  });

  let yData = $derived.by(() => {
    if (!yColumn || !setup?.actualYScaleType) return null;
    
    const rawArray = yColumn.toArray();
    
    if (setup.actualYScaleType === 'band' || setup.actualYScaleType === 'point') {
      return chartContext.yScaleState.processDataForGPU(rawArray, setup.markId);
    } else {
      if (rawArray instanceof Float32Array) {
        return rawArray;
      } else {
        return new Float32Array(rawArray); // Copy only when necessary
      }
    }
  });

  // Color Channel
  let colorData = $derived.by(() => {
    if (!colorColumn || !instanceCount || !colorScale) return null;
    
    const colorArray = colorColumn.toArray(); // Zero-copy
    const rgba = new Float32Array(instanceCount * 4);
    
    for (let i = 0; i < instanceCount; i++) {
      const colorValue = colorArray[i];
      const fillColor = colorScale(colorValue);
      const parsed = parseColor(fillColor);
      rgba.set(parsed, i * 4);
    }
    
    return rgba;
  });

  // Radius Channel (prop-based, but follows same pattern)
  let radiusData = $derived.by(() => {
    if (!instanceCount) return null;
    
    const radii = new Float32Array(instanceCount);
    
    if (typeof radius === 'function') {
      // Handle function-based radius (access other columns if needed)
      const xArray = xColumn?.toArray();
      const yArray = yColumn?.toArray();
      
      for (let i = 0; i < instanceCount; i++) {
        radii[i] = radius({ x: xArray?.[i], y: yArray?.[i] });
      }
    } else {
      radii.fill(radius);
    }
    
    return radii;
  });

  // Alpha Channel (simple, but consistent pattern)
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


  $effect(() => {
    console.log('mark effect')
    void config,  xScaleId, yScaleId; // and other relevant props
    
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


  // $effect(() => {
  //   console.log('🔍 DotsMark Data Processing:', {
  //     // Setup status
  //     setupReady: !!setup,
  //     gpuReady: setup?.gpuReady,
  //     scaleCompatibilityError: setup?.scaleCompatibilityError,
      
  //     // Raw data
  //     arrowTable: !!arrowTable,
  //     instanceCount,
      
  //     // Processed data arrays
  //     xData: xData ? `${xData.length} items, sample: [${Array.from(xData.slice(0, 3)).join(', ')}]` : 'null',
  //     yData: yData ? `${yData.length} items, sample: [${Array.from(yData.slice(0, 3)).join(', ')}]` : 'null',
  //     colorData: colorData ? `${colorData.length/4} items (rgba)` : 'null',
  //     radiusData: radiusData ? `${radiusData.length} items` : 'null',
  //     alphaData: alphaData ? `${alphaData.length} items` : 'null',
      
  //     // Scale info that affects data processing
  //     actualXScaleType: setup?.actualXScaleType,
  //     actualYScaleType: setup?.actualYScaleType,
      
  //     // Chart context status
  //     chartReady: chartContext.isReady,
  //     scalesReady: chartContext.scalesReady,
      
  //     // What component will render
  //     willRenderDots: !!(setup?.gpuReady && xData && yData),
  //   });
  // });

  // // Add this debugging effect to DotsMark.svelte
  // $effect(() => {
  //   if (setup?.gpuReady && chartContext.scalesReady) {
  //     console.log('🔍 Scale Domain Debug:', {
  //       // X scale domain
  //       xScaleDomain: chartContext.xScaleState?.domain?.current,
  //       xScaleRange: [0, chartContext.innerWidth],
        
  //       // Y scale domain  
  //       yScaleDomain: chartContext.yScaleState?.domain?.current,
  //       yScaleRange: [chartContext.innerHeight, 0], // Flipped for screen coords
        
  //       // Sample data for comparison
  //       xDataSample: xData ? Array.from(xData.slice(0, 5)) : 'none',
  //       yDataSample: yData ? Array.from(yData.slice(0, 5)) : 'none',
        
  //       // Expected screen positions (manual calculation)
  //       expectedScreenPositions: xData && yData ? {
  //         xSample: Array.from(xData.slice(0, 3)),
  //         ySample: Array.from(yData.slice(0, 3))
  //       } : 'no data'
  //     });
  //   }
  // });
</script>


{#if setup?.gpuReady && xData && yData}
  <Dots
    {xData}
    {yData}
    {colorData}
    {radiusData}
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
    Initializing mark...
  </text>
{/if}