<script>
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
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

  const coordinator = getContext('mosaic-coordinator');
  const chartContext = getContext('chart');
  let setup = $state(null);
  let xScaleId = $derived(chartContext.xScaleState?.id);
  let yScaleId = $derived(chartContext.yScaleState?.id);

  const config = $derived({
    // Mark metadata
    markType: 'dot',
    supportedScaleTypes: {
      x: ['linear', 'identity', 'band', 'point', 'time', 'log'],
      y: ['linear', 'identity', 'band', 'point', 'time', 'log']
    },
    
    // Scale requirements passed to constructor
    scaleRequirements: {
      x: { type: preferredXScaleType, priority: SCALE_PRIORITIES.PREFER },
      y: { type: preferredYScaleType, priority: SCALE_PRIORITIES.PREFER }
    },
    
    // Data configuration
    table,
    selection,
    select: { x, y, ...(color && { color }) },
    
    // DataClient options
    clientOptions: {
      limit,
      filterNulls: filterNulls ? [x, y] : null
    }
  })

  $effect(() => {
    console.log('mark effect')
    void config,  xScaleId, yScaleId; // and other relevant props
    
    untrack(() => {
      setup?.destroy();
      
      setup = new BaseMarkSetup(
        config,
        coordinator,
        chartContext
      );
    });
  });

  onDestroy(() => {
    setup?.destroy();
  });
</script>


{#if setup?.client?.arrowTable && setup.gpuReady}
  <Dots
    data={setup.client.arrowTable}
    dataVersion={setup.client.dataVersion}
    xScaleType={setup.actualXScaleType}
    yScaleType={setup.actualYScaleType}
    {alpha}
    r={radius}
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