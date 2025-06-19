<!-- src/lib/components/marks/DotsMark.svelte -->
<script>
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
  import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
  import { Dots } from '../rendering/index.js';
  import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';

  // =================================================================
  // ==  PROPS: The Public API of the Mark                        ==
  // =================================================================

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

  // =================================================================
  // ==  CONTEXT & CONTROLLER SETUP                               ==
  // =================================================================

  const coordinator = getContext('mosaic-coordinator');
  const chartContext = getContext('chart');

  // ✅ REACTIVE: Create setup with scale requirements in config
  // The reactive effects in BaseMarkSetup will handle all initialization automatically
  const setup = new BaseMarkSetup(
    {
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
    },
    coordinator,
    chartContext
  );

  // =================================================================
  // ==  LIFECYCLE MANAGEMENT                                     ==
  // =================================================================

  onMount(() => {
    console.log(`🎯 Mounting DotsMark with setup ${setup.markId}`);
    // ✅ REACTIVE: No more setup.setup() call! 
    // The reactive effects in BaseMarkSetup handle everything automatically
    setup.registerInitialScaleRequirements();
    
    // Optional: Monitor setup progress in development
    if (process.env.NODE_ENV === 'development') {
      console.log(`📊 DotsMark ${setup.markId} mounted, reactive setup will begin automatically`);
    }
  });

  // ✅ REACTIVE: Handle scale type preference changes
  $effect(() => {
    void preferredXScaleType, preferredYScaleType;
    
    untrack(() => {
      console.log(`🔄 ${setup.markId} Scale type preferences changed to x:${preferredXScaleType}, y:${preferredYScaleType}`);
      setup.updateScaleRequirements({
        x: { type: preferredXScaleType, priority: SCALE_PRIORITIES.PREFER },
        y: { type: preferredYScaleType, priority: SCALE_PRIORITIES.PREFER }
      });
    });
  });

  // ✅ REACTIVE: Handle data/config changes
  $effect(() => {
    void table, selection, x, y, color, limit, filterNulls;
    
    untrack(() => {
      console.log(`📝 ${setup.markId} Data config changed`);
      setup.updateConfig({ 
        table, 
        selection, 
        x, 
        y, 
        color,
        select: { x, y, ...(color && { color }) },
        clientOptions: { 
          limit, 
          filterNulls: filterNulls ? [x, y] : null 
        } 
      });
    });
  });

  // ✅ REACTIVE: Optional monitoring effect for development
  if (process.env.NODE_ENV === 'development') {
    $effect(() => {
      const progress = {
        scaleCompatibilityError: setup.scaleCompatibilityError,
        gpuReady: setup.gpuReady,
        hasClient: !!setup.client,
        hasData: !!setup.client?.arrowTable,
        categoricalDataFetched: setup.categoricalDataFetched,
        actualScaleTypes: {
          x: setup.actualXScaleType,
          y: setup.actualYScaleType
        }
      };
      
      console.debug(`🔍 DotsMark ${setup.markId} status:`, progress);
    });
  }

  // ✅ REACTIVE: Cleanup
  onDestroy(() => {
    console.log(`🧹 Destroying DotsMark ${setup.markId}`);
    setup.destroy();
  });
</script>

<!-- ================================================================= -->
<!-- ==  VIEW & RENDERING LOGIC                                     == -->
<!-- ================================================================= -->

{#if setup.scaleCompatibilityError}
  <!-- Display scale compatibility error -->
  <text x={chartContext.margin.left} y={chartContext.margin.top} fill="red" font-size="12">
    Scale Error: {setup.scaleCompatibilityError}
  </text>
{:else if setup.client?.arrowTable && setup.gpuReady}
  <!-- ✅ REACTIVE: Render when data and GPU are ready -->
  <!-- 
    Debug Info: Mark {setup.markId}
    - Scale Types: x={setup.actualXScaleType}, y={setup.actualYScaleType}
    - GPU Ready: {setup.gpuReady}
    - Data Rows: {setup.client.arrowTable.numRows}
    - Categorical Data Fetched: {setup.categoricalDataFetched}
  -->
  
  <Dots
    data={setup.client.arrowTable}
    dataVersion={setup.client.dataVersion}
    xScaleType={setup.actualXScaleType}
    yScaleType={setup.actualYScaleType}
    {alpha}
    r={radius}
  />
{:else if setup.client?.error}
  <!-- Display data error -->
  <text x={chartContext.margin.left} y={chartContext.margin.top} fill="red" font-size="12">
    Error: {setup.client.error.message}
  </text>
{:else if setup.client?.delayedLoading}
  <!-- Display loading state -->
  <text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
    Loading data...
  </text>
{:else}
  <!-- Display initialization state -->
  <text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
    Initializing mark...
    {#if process.env.NODE_ENV === 'development'}
      <!-- Debug info in development -->
      <tspan x={chartContext.margin.left} dy="15" font-size="10" fill="gray">
        Scales: {setup.actualXScaleType || 'pending'} × {setup.actualYScaleType || 'pending'}
        | GPU Ready: {setup.gpuReady}
      </tspan>
    {/if}
  </text>
{/if}