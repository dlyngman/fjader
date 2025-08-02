  <script>
    import { format } from 'd3-format';
    import { getContext } from 'svelte';

    let { ticksNumber = 5 } = $props();
    const c = getContext('chart');

    const formatter = $derived(c.yScale.tickFormat());
  </script>

    
  <!-- {#if c.yScale && c.innerHeight && c.scalesReady} -->
  {#if c.isReady}
    <g class="axis">
      <!-- <line stroke="currentColor" x1={0} y1={innerHeight} x2={0} y2={0} /> -->
      <!-- {#each c.yScale.ticks(ticksNumber) as tick (tick)} -->
      {#if c.scaleTypes.y === 'linear'}
        {#each c.yScale.ticks(ticksNumber) as tick (tick)}
          <line
            x1={0}
            x2={-6}
            y1={c.yScale(tick)}
            y2={c.yScale(tick)} />

          <text
            text-anchor="end"
            dominant-baseline="middle"
            x={-9}
            y={c.yScale(tick)}>
            <!-- {formatter(tick)} -->
            {format("~s")(tick)}
          </text>
        {/each}

        <text
          text-anchor="middle"
          transform={`translate(-32, ${c.innerHeight / 2}) rotate(-90)`}
        >
          {c.yLabel}
        </text>
      {:else if c.scaleTypes.y === 'band'}
        {#each c.yScale.domain() as tick (tick)}
          {@const tickY = c.yScale(tick)}
          <line
            x1={0}
            x2={-6}
            y1={tickY + c.yScale.bandwidth() / 2}
            y2={tickY + c.yScale.bandwidth() / 2} />

          <text
            text-anchor="end"
            dominant-baseline="middle"
            x={-9}
            y={tickY + c.yScale.bandwidth() / 2}>
            <!-- {formatter(tick)} -->
            {tick}
            <!-- {format("~s")(tick)} -->
          </text>
        {/each}

        <text
          text-anchor="middle"
          transform={`translate(-32, ${c.innerHeight / 2}) rotate(-90)`}
        >
          {c.yLabel}
        </text>
      {/if}
    </g>
  {/if}

  <style>
    line {
      stroke: var(--text-secondary);
    }

    text {
      fill: var(--text-secondary);
      font-size: 10px;
    }
  </style>