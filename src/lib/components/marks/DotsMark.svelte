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
    limit = 5000 
  } = $props();

  const coordinator = getContext('mosaic-coordinator');
  const c = getContext('chart');

  const markId = `dot-${crypto.randomUUID().slice(0, 8)}`;

  // Get color scale for the color encoding
  let colorScale = $derived(getScaleState(color, 'ordinal'));
  let client = $state(null);

  // Register scale types with chart container BEFORE creating client
  // Move inside createClient in case we need to change depending on x/y 
  c.registerScaleType('x', 'linear', SCALE_PRIORITIES.PREFER, markId);
  c.registerScaleType('y', 'linear', SCALE_PRIORITIES.PREFER, markId);
  // c.registerScaleType('x', 'linear');
  // c.registerScaleType('y', 'linear');

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

  // // Loading state coordination (optional)
  // $effect(() => {
  //   if (client?.delayedLoading) {
  //     c.xScaleState?.setUpdatesEnabled?.(false);
  //     c.yScaleState?.setUpdatesEnabled?.(false);
  //   } else {
  //     c.xScaleState?.setUpdatesEnabled?.(true);
  //     c.yScaleState?.setUpdatesEnabled?.(true);
  //   }
  // });

  onDestroy(() => {
    c.unregisterScaleType('x', markId);
    c.unregisterScaleType('y', markId);

    if (client) {
      client.destroy();
    }
  });

</script>

{#if client?.arrowTable}
  <Dots
    data={client.arrowTable}
    dataVersion={client.dataVersion}
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