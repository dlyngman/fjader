<script>
    import { DataClient } from '$lib/data-clients/DataClient.svelte.js';
    import { getContext, onMount, onDestroy, untrack } from 'svelte';
    import { getScaleState } from '$lib/scales';
    import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
    // import { Rects } from '$lib/components';
    import { Dots } from '$lib/components';
  
    let { 
      table, 
      selection, 
      x, 
      y, 
      color, 
      alpha = 0.8,
      orientation = 'vertical', // 'vertical' | 'horizontal'
      limit = 5000 
    } = $props();
  
    const coordinator = getContext('mosaic-coordinator');
    const c = getContext('chart');
  
    const markId = `bar-${crypto.randomUUID().slice(0, 8)}`;
  
    // Get color scale for the color encoding
    let colorScale = $derived(getScaleState(color, 'ordinal'));
    let client = $state(null);
  
    // Register scale types based on orientation
    // Vertical bars: x=categorical (band), y=continuous (linear)
    // Horizontal bars: x=continuous (linear), y=categorical (band)
    if (orientation === 'vertical') {
      c.registerScaleType('x', 'band', SCALE_PRIORITIES.MANDATE, markId);
      c.registerScaleType('y', 'linear', SCALE_PRIORITIES.PREFER, markId);
    } else {
      c.registerScaleType('x', 'linear', SCALE_PRIORITIES.PREFER, markId);
      c.registerScaleType('y', 'band', SCALE_PRIORITIES.MANDATE, markId);
    }
  
    function createClient() {
      if (client) {
        client.destroy();
        client = null;
      }
  
      client = new DataClient(table, selection, {
        select: { x, y },
        // select: { x, y, color },
        limit,
        // filterNulls: [x, y],
        dataFormat: 'array',
        name: markId
      });
  
      if (coordinator) {
        coordinator.connect(client);
      }
    }

    // In BarMark.svelte or any mark needing band scales
    async function fetchCategoricalDomain() {
        console.log('fetching categories')

        if (c.scaleTypes?.x !== 'band' && c.scaleTypes?.y !== 'band') {
            return; // No categorical scales needed
        }
        
        // Fetch distinct values for x-axis if it's categorical
        if (c.scaleTypes?.x === 'band') {
            const distinctQuery = Query.from(table)
            .select({ x: sqlColumn(x) })
            .distinct();
            
            const result = await coordinator.query(distinctQuery);
            const categories = Array.from(result).map(row => row.x);
            
            c.xScaleState.addMark(categories, markId);
        }

        if (c.scaleTypes?.y === 'band') {
            const distinctQuery = Query.from(table)
            .select({ y: sqlColumn(y) })
            .distinct();
            
            const result = await coordinator.query(distinctQuery);
            const categories = Array.from(result).map(row => row.y);
            
            c.xScaleState.addMark(categories, markId);
        }
    }
  
    onMount(async () => {
        await fetchCategoricalDomain();
        createClient();
    });
  
    $effect(() => {
      void x; void y; void color; void table; void orientation;
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

    $inspect(client?.data)
  
  </script>
  
  {#if client?.arrowTable}
    <Dots
      data={client.arrowTable}
      dataVersion={client.dataVersion}
      alpha={alpha}
      orientation={orientation}
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