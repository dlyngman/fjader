<!-- src/lib/components/marks/DotsMark.svelte -->
<script>
  import { DataClient } from '$lib/data-clients/DataClient.svelte.js';
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
  import { getScaleState } from '$lib/scales';
  import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
  import { Dots } from '$lib/components';

  let { 
    table, 
    selection, 
    x, 
    y, 
    color, 
    alpha = 0.5, 
    radius = 3,
    limit,
    // These are PREFERENCES, not guarantees
    preferredXScaleType = 'linear', 
    preferredYScaleType = 'linear',
  } = $props();

  const coordinator = getContext('mosaic-coordinator');
  const c = getContext('chart');

  const markId = `dot-${crypto.randomUUID().slice(0, 8)}`;

  // Get color scale for the color encoding
  let colorScale = $derived(getScaleState(color, 'ordinal'));
  let client = $state(null);

  // Register scale type PREFERENCES with chart container
  // These are requests that may be overridden by higher priority marks
  c.registerScaleType('x', preferredXScaleType, SCALE_PRIORITIES.PREFER, markId);
  c.registerScaleType('y', preferredYScaleType, SCALE_PRIORITIES.PREFER, markId);

  // Get the ACTUAL resolved scale types from the chart's scale resolution
  // This is what we'll actually get, which may differ from our preferences
  let actualXScaleType = $derived(c.scaleTypes?.x || 'linear');
  let actualYScaleType = $derived(c.scaleTypes?.y || 'linear');

  // Validation: Check if dots can work with the resolved scale types
  let scaleCompatibilityError = $derived.by(() => {
    // Dots generally work with linear and identity scales well
    // They can work with band/point scales but might not look ideal
    const incompatibleX = actualXScaleType && !['linear', 'identity', 'band', 'point'].includes(actualXScaleType);
    const incompatibleY = actualYScaleType && !['linear', 'identity', 'band', 'point'].includes(actualYScaleType);
    
    if (incompatibleX || incompatibleY) {
      return `DotsMark cannot render with scale types: x=${actualXScaleType}, y=${actualYScaleType}`;
    }
    
    // Warn if we got something different from what we preferred
    if (actualXScaleType !== preferredXScaleType || actualYScaleType !== preferredYScaleType) {
      console.warn(
        `DotsMark: Scale types resolved differently than preferred. ` +
        `Preferred: x=${preferredXScaleType}, y=${preferredYScaleType}. ` +
        `Actual: x=${actualXScaleType}, y=${actualYScaleType}. ` +
        `This might be due to other marks with higher priority requirements.`
      );
    }
    
    return null;
  });

  function createClient() {
    if (client) {
      client.destroy();
      client = null;
    }

    client = new DataClient(table, selection, {
      select: { x, y, color },
      limit,
      filterNulls: [x, y],
      dataFormat: 'arrow',
      name: markId
    });

    if (coordinator) {
      coordinator.connect(client);
    }
  }

  onMount(() => {
    createClient();
  });

  $effect(() => {
    void x; void y; void color; void table;
    untrack(() => {
      if (client) createClient();
    })
  });

  onDestroy(() => {
    c.unregisterScaleType('x', markId);
    c.unregisterScaleType('y', markId);

    if (client) {
      client.destroy();
    }
  });

</script>

{#if scaleCompatibilityError}
  <text x={c.marginLeft ?? 20} y={c.marginTop ?? 20} fill="red" font-size="14">
    Scale Error: {scaleCompatibilityError}
  </text>
{:else if client?.arrowTable}
  <!-- Pass the ACTUAL resolved scale types, not the requested ones -->
  <Dots
    data={client.arrowTable}
    dataVersion={client.dataVersion}
    xScaleType={actualXScaleType}
    yScaleType={actualYScaleType}
    alpha={alpha}
    r={radius}
  />
{:else if client?.error}
  <text x={c.marginLeft ?? 20} y={c.marginTop ?? 20} fill="red" font-size="14">
    Error: {client.error.message}
  </text>
{:else if client?.delayedLoading}
  <text x={c.marginLeft ?? 20} y={c.marginTop ?? 20} fill="currentColor" font-size="14">
    Loading...
  </text>
{:else}
  <text x={c.marginLeft ?? 20} y={c.marginTop ?? 20} fill="currentColor" font-size="14">
    No data available
  </text>
{/if}