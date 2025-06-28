<script>
  import { setContext, onDestroy } from 'svelte';
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

  let scales = $derived(new ChartScales({
    xLabel,
    yLabel,
    layout
  }));

  const gpuCoordinator = getGPUContext();
  const requesterId = `chart-hover-${layout.chartId}`; // A unique ID for this chart's hover state
  let leaveTimeout = null; // To hold the ID of our setTimeout
  const DEACTIVATION_DELAY = 1000; // Longer than longest animation


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

  // GPUCoordinator handlers
  function handleContainerMouseEnter() {
    // If a "go to sleep" timer is pending from a previous mouse leave, cancel it.
    // This handles cases where the user quickly leaves and re-enters the chart.
    if (leaveTimeout) {
    clearTimeout(leaveTimeout);
      leaveTimeout = null;
    }

    // Wake up the render loop. The coordinator handles multiple requests gracefully.
    gpuCoordinator.requestActiveLoop(requesterId);
  }

  function handleContainerMouseLeave() {
    // Don't stop the loop immediately. Instead, set a timer.
    // This gives any animations triggered by interactions (like double-click reset)
    // time to complete smoothly even after the mouse has left the chart.
    leaveTimeout = setTimeout(() => {
      gpuCoordinator.releaseActiveLoop(requesterId);
      leaveTimeout = null; // Clear the timer ID after it has run
      // console.log('loop cancel request sent')
    }, DEACTIVATION_DELAY);
    }
  
  // ZOOM HANDLERS
  function handleWheel(event) {
    event.preventDefault();
    const point = { x: event.offsetX, y: event.offsetY };
    const { x, y, innerPoint } = layout.getActiveAxes(point);
    
    const scaleFactor = event.deltaY < 0 
      ? 1 + Math.abs(event.deltaY) * 0.0025 
      : 1 - Math.abs(event.deltaY) * 0.0025;
    
    scales.applyZoom(innerPoint, scaleFactor, x, y);
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
  
  // PAN HANDLERS
  function handlePointerDown(event) {
    event.preventDefault();
    
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    
    scales.clearCurrentDataPoints();
    
    const point = { x: event.offsetX, y: event.offsetY };
    const { x, y, innerPoint } = layout.getActiveAxes(point);
    
    activePanX = x;
    activePanY = y;
    isPanning = true;
    panningAnchorPoint = scales.calculatePanningAnchor(innerPoint);

    if (event.target.setPointerCapture) {
      event.target.setPointerCapture(event.pointerId);
    }
  }

  function handlePointerMove(event) {
    if (!isPanning) return;
    
    event.preventDefault();
    const point = { x: event.offsetX, y: event.offsetY };
    const innerPoint = layout.toInnerCoordinates(point);
    const { dx, dy } = scales.calculatePanDeltas(innerPoint, panningAnchorPoint);
    
    scales.applyPan(dx, dy, activePanX, activePanY);
  }
  
  function handlePointerUp() {
    isPanning = false;
    activePanX = false;
    activePanY = false;
  }

  // MOUSE TRACKING HANDLERS  
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

  onDestroy(() => {
    // If the component is destroyed, cancel any pending "go to sleep" timer.
    if (leaveTimeout) {
        clearTimeout(leaveTimeout);
    }

    // Always release this component's hold on the active loop when it's destroyed.
    gpuCoordinator.releaseActiveLoop(requesterId);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div 
  class="chart-container" 
  bind:clientWidth={layout.width} 
  bind:clientHeight={layout.height}
  onmouseenter={handleContainerMouseEnter}
  onmouseleave={handleContainerMouseLeave}
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
      ontouchstart={handleTouchStart}
      ontouchmove={handleTouchMove}
      ontouchend={handleTouchEnd}
      ontouchcancel={handleTouchEnd}
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
        onmousemove={handleInnerMouseMove}
        onmouseenter={handleInnerMouseEnter}
        onmouseleave={handleInnerMouseLeave}
      >
        {@render foreground?.()}
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

<style>
  .chart-container {
    position: relative;
    flex: 1;
    height: 100%;
    contain: layout style paint;
  }

  .svg-background, .canvas-layer, .svg-foreground {
    position: absolute;
    top: 0;
    left: 0;
  }

  .svg-background { z-index: 1; }
  .canvas-layer { z-index: 2; }
  .svg-foreground { z-index: 3; }

  .crosshair {
    cursor: crosshair;
  }
</style>