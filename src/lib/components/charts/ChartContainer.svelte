<script>
  import { setContext, onDestroy, untrack, onMount } from 'svelte';
  import { ChartLayout } from '$lib/layout/ChartLayout.svelte.js';
  import { ChartScales } from '$lib/scales/ChartScales.svelte';
  import { getGPUContext } from '$lib/gpu';

  let {
    xLabel,
    yLabel,
    background,
    foreground,
    canvas,
    canvasComponents
  } = $props();

  // Create layout and scale coordinator
  const layout = new ChartLayout({ 
    margin: { top: 30, right: 50, bottom: 35, left: 75 }, 
    height: 250 
  });

  const gpuCoordinator = getGPUContext();

  // TODO: change to effect? We are registrating and possibly de-registrating side effects inside, resolving charts?
  let scales = $derived(new ChartScales({
    xLabel,
    yLabel,
    layout,
    gpuCoordinator
  }));


  $effect(() => {
      console.log(`🎯 ChartContainer scales object changed for ${xLabel}x${yLabel}:`, scales);
    });

    $effect(() => {
    const xState = scales.xScaleState;
    const yState = scales.yScaleState;
    
    console.log(`🎯 Chart ${xLabel}x${yLabel} scale state instances:`, {
      xStateId: xState?.name,
      yStateId: yState?.name,
      xStateObject: xState,
      yStateObject: yState,
      // Check if it's the same object reference
      xStateSame: window.lastXState === xState,
      yStateSame: window.lastYState === yState
    });
    
    // Store for comparison (dev only)
    if (typeof window !== 'undefined') {
      window.lastXState = xState;
      window.lastYState = yState;
    }
  });

  $effect(() => {
    const xScale = chartContext.xScaleState;
    const yScale = chartContext.yScaleState;
    
    if (xScale && yScale && layout.isReady) {
      // For test data, manually mark scales as ready
      if (!xScale.ready) {
        xScale.setReady?.();
        console.log('Manually marked X scale ready');
      }
      if (!yScale.ready) {
        yScale.setReady?.();
        console.log('Manually marked Y scale ready');
      }
      
      // Then trigger render
      gpuCoordinator.invalidateChart(layout.chartId);
    }
  });

  // $inspect('is ready', layout.isReady)

  const chartContext = {
    // Layout properties and methods
    get width() { return layout.width; },
    get height() { return layout.height; },
    get innerWidth() { return layout.innerWidth; },
    get innerHeight() { return layout.innerHeight; },
    get margin() { return layout.margin; },
    get chartId() { return layout.chartId; },
    get clipPathId() { return layout.clipPathId; },
    get clipPathUrl() { return layout.clipPathUrl; },
    get isReady() { return layout.isReady; },
    get innerTransform() { return layout.innerTransform; },
    get dimensions() { return layout.dimensions; },
    
    // Layout methods
    updateWidth: layout.updateWidth.bind(layout),
    updateHeight: layout.updateHeight.bind(layout),
    updateMargin: layout.updateMargin.bind(layout),
    toInnerCoordinates: layout.toInnerCoordinates.bind(layout),
    toScreenCoordinates: layout.toScreenCoordinates.bind(layout),
    isWithinInnerBounds: layout.isWithinInnerBounds.bind(layout),
    getActiveAxes: layout.getActiveAxes.bind(layout),
    reset: layout.reset.bind(layout),
    getDebugInfo: layout.getDebugInfo.bind(layout),

    // Scale coordinator properties - reactive to scales changes
    get xScale() { return scales.xScale?.scale; },
    get yScale() { return scales.yScale?.scale; },
    get xTargetScale() { return scales.xTargetScale?.scale; },
    get yTargetScale() { return scales.yTargetScale?.scale; },
    
    get xLabel() { return scales.xLabel; },
    get yLabel() { return scales.yLabel; },
    
    get currentXDataPoint() { return scales.currentXDataPoint; },
    get currentYDataPoint() { return scales.currentYDataPoint; },
    get currentXScreenPoint() { return scales.currentXScreenPoint; },
    get currentYScreenPoint() { return scales.currentYScreenPoint; },
    
    get xScaleState() { return scales.xScaleState; },
    get yScaleState() { return scales.yScaleState; },
    
    get scaleTypes() { return scales.scaleTypes; },
    get scalesReady() { return scales.scalesReady; },
    get active() { return scales.active; },
    get xCategoryPositions() { return scales.xCategoryPositions; },
    get yCategoryPositions() { return scales.yCategoryPositions; },
    get categoryPositionsReady() { return scales.categoryPositionsReady; },
    get xBandwidth() { return scales.xBandwidth; },
    get yBandwidth() { return scales.yBandwidth; },
    
    // Scale coordinator methods
    registerScaleType: (dimension, type, priority, markId) => scales.registerScaleType(dimension, type, priority, markId),
    unregisterScaleType: (dimension, markId) => scales.unregisterScaleType(dimension, markId),
    getScaleRequirementsSummary: () => scales.getScaleRequirementsSummary()
  };

  setContext('chart', chartContext);
  
  // Interaction state
  let svg = $state();
  let isPanning = $state(false);
  let activePanX = $state(false);
  let activePanY = $state(false);
  let panningAnchorPoint = { x: 0, y: 0 };
  
  // Touch/pinch zoom state
  let initialTouchDistance = $state(0);
  let isZooming = $state(false);

  // $effect.pre(() => {
  //   const timestamp = performance.now();
  //   // console.log(`⚡ $effect.pre triggered at ${timestamp.toFixed(2)}ms`);
    
  //   void scales.xScaleState?.domain?.current;
  //   void scales.yScaleState?.domain?.current;

  //   untrack(() => {
  //       if (layout.isReady) {
  //         console.log(`📊 Invalidating chart at ${timestamp.toFixed(2)}ms`);
  //         gpuCoordinator.invalidateChart(layout.chartId);
  //       }
  //   });
  // });
  
  // ZOOM HANDLERS
  function handleWheel(event) {
    // console.log(`🖱️ Wheel event at ${performance.now().toFixed(2)}ms`);

    event.preventDefault();
    const point = { x: event.offsetX, y: event.offsetY };
    const { x, y, innerPoint } = layout.getActiveAxes(point);
    
    const scaleFactor = event.deltaY < 0 
      ? 1 + Math.abs(event.deltaY) * 0.0025 
      : 1 - Math.abs(event.deltaY) * 0.0025;
    
    // scales.applyZoom(innerPoint, scaleFactor, x, y);
    scales.accumulateZoom(innerPoint, scaleFactor, x, y);

    // console.log(`🎯 Scale update triggered at ${performance.now().toFixed(2)}ms`);

  }
  
  function handleDoubleClick(event) {
    event.preventDefault();
    const point = { x: event.offsetX, y: event.offsetY };
    const { x, y } = layout.getActiveAxes(point);
    scales.resetZoom({ x, y });
  }
  
  // TOUCH HANDLERS
  function getTouchDistance(touches) {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  function handleTouchStart(event) {
    if (event.touches.length === 2) {
      event.preventDefault();
      isZooming = true;
      initialTouchDistance = getTouchDistance(event.touches);
      
      const point = { x: event.offsetX, y: event.offsetY };
      const { x, y } = layout.getActiveAxes(point);
      activePanX = x;
      activePanY = y;
    }
  }
  
  function handleTouchMove(event) {
    if (!isZooming || event.touches.length !== 2) return;
    
    const currentDistance = getTouchDistance(event.touches);
    const scaleFactor = currentDistance / initialTouchDistance;
    
    if (Math.abs(scaleFactor - 1) > 0.01) {
      const point = { x: event.offsetX, y: event.offsetY };
      const { innerPoint } = layout.getActiveAxes(point);
      
      scales.applyZoom(innerPoint, scaleFactor, activePanX, activePanY);
      initialTouchDistance = currentDistance;
    }
  }
  
  function handleTouchEnd() {
    isZooming = false;
    isPanning = false;
    activePanX = false;
    activePanY = false;
  }

  let panContext;

  // PAN HANDLERS
  function handlePointerDown(event) {
    event.preventDefault();
    
    const point = { x: event.offsetX, y: event.offsetY };
    const { x, y, innerPoint } = layout.getActiveAxes(point);
    
    // Only allow panning on linear scales
    activePanX = x && scales.scaleTypes?.x === 'linear';
    activePanY = y && scales.scaleTypes?.y === 'linear';
  
    // Only proceed if at least one axis can pan
    if (!activePanX && !activePanY) {
      return;
    }
    isPanning = true;

    scales.startPan({ x: event.offsetX, y: event.offsetY }, activePanX, activePanY);
  
    scales.clearCurrentDataPoints();
    event.target.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    if (!isPanning) return;

    // Get coalesced events for higher resolution input data
    const coalescedEvents = event.getCoalescedEvents?.() || [event];
  
    // Pass all coalesced events to the scales coordinator
    scales.updatePanPositionWithCoalescing(coalescedEvents);
    
    // scales.updatePanPosition(event.offsetX, event.offsetY);    
  }

  function handlePointerUp(event) {
    isPanning = false;
    activePanX = false;
    activePanY = false;
    
    event.target.releasePointerCapture?.(event.pointerId);
    scales.endPan();
  }

  function handleInnerMouseEnter() {
    scales.active = true;
  }

  function handleInnerMouseLeave() {
    scales.clearCurrentDataPoints();
    scales.active = false;
  }

  function handleInnerMouseMove(event) {
    const innerPoint = layout.toInnerCoordinates({ x: event.offsetX, y: event.offsetY });
    scales.updateCurrentDataPoints(innerPoint);
  }

  let testRenderLoop;
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div 
  class="chart-container" 
  bind:clientWidth={layout.width} 
  bind:clientHeight={layout.height}
>  
  {#if layout.isReady}
    <svg 
      class="svg-background" 
      width={layout.width}
      height={layout.height}
    >
      <g transform={layout.innerTransform}>
        {@render background?.()}
      </g>
    </svg>

    <div class="canvas-layer">
      {@render canvas?.()}
    </div>
    
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <svg
      class="svg-foreground"
      bind:this={svg}
      width={layout.width}
      height={layout.height}
      onwheel={handleWheel}
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerUp}
      ondblclick={handleDoubleClick}
    >
      <defs>
        <clipPath id={layout.clipPathId}>
          <rect x={0} y={0} width={layout.innerWidth} height={layout.innerHeight} />
        </clipPath>
      </defs>
      
      <g
        transform={layout.innerTransform}
        clip-path={layout.clipPathUrl}
        class="crosshair"
        onpointermove={handleInnerMouseMove}
        onpointerenter={handleInnerMouseEnter}
        onpointerleave={handleInnerMouseLeave}
      >
        {@render foreground?.()}
          {#if scales.xScale && scales.yScale}
            <circle 
              cx={scales.xScale.scale(50)} 
              cy={scales.yScale.scale(25)} 
              r="8" 
              fill="red" 
              opacity="0.7"
              stroke="darkred"
              stroke-width="2"
            />
            
            <!-- Test rectangle spanning data range (20-80, 10-40) -->
            <rect 
              x={scales.xScale.scale(20)}
              y={scales.yScale.scale(40)} 
              width={scales.xScale.scale(80) - scales.xScale.scale(20)}
              height={scales.yScale.scale(10) - scales.yScale.scale(40)}
              fill="blue" 
              opacity="0.3"
              stroke="darkblue"
              stroke-width="1"
            />
            
            <!-- Test line from (0, 0) to (100, 100) in data coordinates -->
            <line 
              x1={scales.xScale.scale(0)}
              y1={scales.yScale.scale(0)}
              x2={scales.xScale.scale(100)}
              y2={scales.yScale.scale(100)}
              stroke="green" 
              stroke-width="3"
              opacity="0.8"
            />
            
            <!-- Grid of reference points -->
            {#each [25, 50, 75] as xVal}
              {#each [25, 50, 75] as yVal}
                <circle 
                  cx={scales.xScale.scale(xVal)} 
                  cy={scales.yScale.scale(yVal)} 
                  r="3" 
                  fill="purple" 
                  opacity="0.5"
                />
              {/each}
            {/each}
          {/if}
          <rect
          x="0"
          y="0"
          width={layout.innerWidth}
          height={layout.innerHeight}
          fill="transparent"
          />
      </g>
    </svg>
  {/if}
</div>

<pre id="info">cpuTime: {gpuCoordinator.timings.cpu}
fps: {gpuCoordinator.timings.fps}
gpu: {gpuCoordinator.timings.gpu} µs
</pre>

<style>
  .chart-container {
    position: relative;
    flex: 1;
    height: 100%;
    contain: layout style paint;
    /* contain: strict; */
    touch-action: none;
    overscroll-behavior: none;
    transform: translateZ(0);
  }

  .svg-background, .canvas-layer, .svg-foreground {
    position: absolute;
    top: 0;
    left: 0;
    touch-action: none;
  }

  .svg-background { 
    z-index: 1; 
  }
  .canvas-layer { z-index: 2; }
  .svg-foreground { 
    z-index: 3; 
  }

  .crosshair {
    cursor: crosshair;
  }

  #info {
    position: absolute;
    top: 0;
    left: 0;
    margin: 0;
    padding: 0.5em;
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
  }
</style>