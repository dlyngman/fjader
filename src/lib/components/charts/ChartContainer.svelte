<script>
  import { setContext } from 'svelte';
  import { ChartLayout } from '$lib/layout/ChartLayout.svelte.js';
  import { ScaleCoordinator } from '$lib/scales/ScaleCoordinator.svelte.js';

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

  let scaleCoordinator = $derived(new ScaleCoordinator({
    xLabel,
    yLabel,
    layout
  }));

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

    // Scale coordinator properties - reactive to scaleCoordinator changes
    get xScale() { return scaleCoordinator.xScale?.scale; },
    get yScale() { return scaleCoordinator.yScale?.scale; },
    get xTargetScale() { return scaleCoordinator.xTargetScale?.scale; },
    get yTargetScale() { return scaleCoordinator.yTargetScale?.scale; },
    
    get xLabel() { return scaleCoordinator.xLabel; },
    get yLabel() { return scaleCoordinator.yLabel; },
    
    get currentXDataPoint() { return scaleCoordinator.currentXDataPoint; },
    get currentYDataPoint() { return scaleCoordinator.currentYDataPoint; },
    get currentXScreenPoint() { return scaleCoordinator.currentXScreenPoint; },
    get currentYScreenPoint() { return scaleCoordinator.currentYScreenPoint; },
    
    get xScaleState() { return scaleCoordinator.xScaleState; },
    get yScaleState() { return scaleCoordinator.yScaleState; },
    
    get scaleTypes() { return scaleCoordinator.scaleTypes; },
    get scalesReady() { return scaleCoordinator.scalesReady; },
    get active() { return scaleCoordinator.active; },
    
    // Scale coordinator methods
    registerScaleType: (dimension, type, priority, markId) => scaleCoordinator.registerScaleType(dimension, type, priority, markId),
    unregisterScaleType: (dimension, markId) => scaleCoordinator.unregisterScaleType(dimension, markId),
    getScaleRequirementsSummary: () => scaleCoordinator.getScaleRequirementsSummary()
  };

  setContext('chart', chartContext);

  // // Set chart context
  // setContext('chart', mergeReactive(
  //   layout.getContextData(),
  //   // scaleCoordinator.getContextData(),
  //   {
  //     // Getters that always reference the current reactive scaleCoordinator
  //     get xScale() { return scaleCoordinator.xScale?.scale; },
  //     get yScale() { return scaleCoordinator.yScale?.scale; },
  //     get xTargetScale() { return scaleCoordinator.xTargetScale?.scale; },
  //     get yTargetScale() { return scaleCoordinator.yTargetScale?.scale; },
      
  //     get xLabel() { return scaleCoordinator.xLabel; },
  //     get yLabel() { return scaleCoordinator.yLabel; },
      
  //     get currentXDataPoint() { return scaleCoordinator.currentXDataPoint; },
  //     get currentYDataPoint() { return scaleCoordinator.currentYDataPoint; },
  //     get currentXScreenPoint() { return scaleCoordinator.currentXScreenPoint; },
  //     get currentYScreenPoint() { return scaleCoordinator.currentYScreenPoint; },
      
  //     get xScaleState() { return scaleCoordinator.xScaleState; },
  //     get yScaleState() { return scaleCoordinator.yScaleState; },
      
  //     get scaleTypes() { return scaleCoordinator.scaleTypes; },
  //     get scalesReady() { return scaleCoordinator.scalesReady; },
  //     get active() { return scaleCoordinator.active; },
      
  //     registerScaleType: (dimension, type) => scaleCoordinator.registerScaleType(dimension, type)
  //   } 
  //     // get xLabel() { return xLabel; },
  //     // get yLabel() { return yLabel; }
  // ));
  
  // Interaction state
  let svg = $state();
  let isPanning = $state(false);
  let activePanX = $state(false);
  let activePanY = $state(false);
  let panningAnchorPoint = { x: 0, y: 0 };
  
  // Touch/pinch zoom state
  let initialTouchDistance = $state(0);
  let isZooming = $state(false);
  
  // ZOOM HANDLERS
  function handleWheel(event) {
    event.preventDefault();
    const point = { x: event.offsetX, y: event.offsetY };
    const { x, y, innerPoint } = layout.getActiveAxes(point);
    
    const scaleFactor = event.deltaY < 0 
      ? 1 + Math.abs(event.deltaY) * 0.0025 
      : 1 - Math.abs(event.deltaY) * 0.0025;
    
    scaleCoordinator.applyZoom(innerPoint, scaleFactor, x, y);
  }
  
  function handleDoubleClick(event) {
    event.preventDefault();
    const point = { x: event.offsetX, y: event.offsetY };
    const { x, y } = layout.getActiveAxes(point);
    scaleCoordinator.resetZoom({ x, y });
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
      
      scaleCoordinator.applyZoom(innerPoint, scaleFactor, activePanX, activePanY);
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
    
    scaleCoordinator.clearCurrentDataPoints();
    
    const point = { x: event.offsetX, y: event.offsetY };
    const { x, y, innerPoint } = layout.getActiveAxes(point);
    
    activePanX = x;
    activePanY = y;
    isPanning = true;
    panningAnchorPoint = scaleCoordinator.calculatePanningAnchor(innerPoint);

    if (event.target.setPointerCapture) {
      event.target.setPointerCapture(event.pointerId);
    }
  }

  function handlePointerMove(event) {
    if (!isPanning) return;
    
    event.preventDefault();
    const point = { x: event.offsetX, y: event.offsetY };
    const innerPoint = layout.toInnerCoordinates(point);
    const { dx, dy } = scaleCoordinator.calculatePanDeltas(innerPoint, panningAnchorPoint);
    
    scaleCoordinator.applyPan(dx, dy, activePanX, activePanY);
  }
  
  function handlePointerUp() {
    isPanning = false;
    activePanX = false;
    activePanY = false;
  }

  // MOUSE TRACKING HANDLERS  
  function handleInnerMouseEnter() {
    scaleCoordinator.active = true;
  }

  function handleInnerMouseLeave() {
    scaleCoordinator.clearCurrentDataPoints();
    scaleCoordinator.active = false;
  }

  function handleInnerMouseMove(event) {
    const innerPoint = layout.toInnerCoordinates({ x: event.offsetX, y: event.offsetY });
    scaleCoordinator.updateCurrentDataPoints(innerPoint);
  }
</script>

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