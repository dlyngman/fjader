<script>
	import { setContext, onDestroy, untrack, onMount, getContext } from 'svelte';
	import { ChartLayout } from '$lib/layout/ChartLayout.svelte.js';
	import { ChartScales } from '$lib/scales/ChartScales.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { WheelInteractionControl } from '$lib/utils/wheelInteractionControl.js';
	import { TooltipManager } from '$lib/interactors/TooltipManager.svelte.js';
	import Tooltip from '$lib/interactors/Tooltip.svelte';
	import HoverIndicator from '$lib/interactors/HoverIndicator.svelte';

	let {
		xLabel = null,
		yLabel = null,
		background,
		foreground,
		canvas,
		canvasComponents,
		overlay,
		interactors,
		wheelInteraction = {
			dwellTimeMs: 250,
			momentumThreshold: 150,
			enabled: true
		}
	} = $props();

	const pointerBuffer = { x: 0, y: 0 };
	const innerPointBuffer = { x: 0, y: 0 };
	const wheelControl = new WheelInteractionControl(wheelInteraction);
	// If layout.getActiveAxes returns an object, we need to refactor that too,

	// Create layout and scale coordinator
	const layout = new ChartLayout({
		margin: { top: 30, right: 50, bottom: 35, left: 75 },
		height: 250
	});

	const scaleRegistry = getContext('scale-registry');
	const gpuCoordinator = getGPUContext();

	const hasPointerRawUpdate = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

	// TODO: change to effect? We are registrating and possibly de-registrating side effects inside, resolving charts?
	// let scales = $derived(
	// 	new ChartScales({
	// 		xLabel,
	// 		yLabel,
	// 		layout,
	// 		gpuCoordinator
	// 	})
	// );
	let scales = $state(null);

	$effect(() => {
		// Explicitly track dependencies
		const x = xLabel;
		const y = yLabel;
		// layout and gpuCoordinator are objects, usually stable, but we track them if they change
		const l = layout;
		const g = gpuCoordinator;

		// Create the new instance
		// Note: We use untrack around the constructor if we don't want the constructor's
		// internal reads to trigger this effect again (though usually safe here).
		const newScales = new ChartScales({
			xLabel: x,
			yLabel: y,
			layout: l,
			gpuCoordinator: g,
			scaleRegistry: scaleRegistry
		});

		scales = newScales;

		// 3. CLEANUP FUNCTION (The Fix)
		// Svelte runs this function before re-running the effect or when the component destroys.
		return () => {
			if (newScales) {
				console.log(`Destroying ChartScales for ${x} / ${y}`);
				newScales.destroy();
			}
		};
	});

	// $effect(() => {
	// 	console.log(`🎯 ChartContainer scales object changed for ${xLabel}x${yLabel}:`, scales);
	// });

	// Tooltip manager
	const coordinator = getContext('mosaic-coordinator');
	let tooltipManager = $state(null);

	$effect(() => {
		if (!scales || !coordinator) return;

		const tm = new TooltipManager(coordinator, scales);
		tooltipManager = tm;

		// Drive tooltip scheduling from the animation loop — no separate RAF
		const frameCallback = () => tm.tick();
		gpuCoordinator.addFrameCallback(frameCallback);

		return () => {
			gpuCoordinator.removeFrameCallback(frameCallback);
			tm.destroy();
		};
	});

	$effect(() => {
		const xState = scales.xScaleState;
		const yState = scales.yScaleState;

		// console.log(`🎯 Chart ${xLabel}x${yLabel} scale state instances:`, {
		// 	xStateId: xState?.name,
		// 	yStateId: yState?.name,
		// 	xStateObject: xState,
		// 	yStateObject: yState,
		// 	// Check if it's the same object reference
		// 	xStateSame: window.lastXState === xState,
		// 	yStateSame: window.lastYState === yState
		// });

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
			// Only mark scales ready if they have valid domains
			// Linear scales need hasDomain, band scales need effectiveDomain.length > 0
			const xHasDomain = xScale.hasDomain ?? xScale.effectiveDomain?.length > 0;
			const yHasDomain = yScale.hasDomain ?? yScale.effectiveDomain?.length > 0;

			if (!xScale.ready && xHasDomain) {
				xScale.setReady?.();
				console.log('Manually marked X scale ready');
			}
			if (!yScale.ready && yHasDomain) {
				yScale.setReady?.();
				console.log('Manually marked Y scale ready');
			}

			// Only trigger render when both scales are ready
			if (xScale.ready && yScale.ready) {
				gpuCoordinator.invalidateChart(layout.chartId);
			}
		}
	});

	// $inspect('is ready', layout.isReady)

	// Client registration for crossfilter
	const markClients = new Set();

	const chartContext = {
		// Layout properties and methods
		get width() {
			return layout.width;
		},
		get height() {
			return layout.height;
		},
		get innerWidth() {
			return layout.innerWidth;
		},
		get innerHeight() {
			return layout.innerHeight;
		},
		get margin() {
			return layout.margin;
		},
		get chartId() {
			return layout.chartId;
		},
		get clipPathId() {
			return layout.clipPathId;
		},
		get clipPathUrl() {
			return layout.clipPathUrl;
		},
		get isReady() {
			return layout.isReady;
		},
		get innerTransform() {
			return layout.innerTransform;
		},
		get dimensions() {
			return layout.dimensions;
		},

		// Layout methods
		// updateWidth: layout.updateWidth.bind(layout),
		// updateHeight: layout.updateHeight.bind(layout),
		// toInnerCoordinates: layout.toInnerCoordinates.bind(layout),
		// toScreenCoordinates: layout.toScreenCoordinates.bind(layout),
		// isWithinInnerBounds: layout.isWithinInnerBounds.bind(layout),
		// getActiveAxes: layout.getActiveAxes.bind(layout),
		// reset: layout.reset.bind(layout),
		// getDebugInfo: layout.getDebugInfo.bind(layout),

		// updateMargin: layout.updateMargin.bind(layout),
		updateWidth: (w) => layout.updateWidth(w),
		updateHeight: (h) => layout.updateHeight(h),
		updateMargin: (m) => layout.updateMargin(m),
		toInnerCoordinates: (p) => layout.toInnerCoordinates(p),
		toScreenCoordinates: (p) => layout.toScreenCoordinates(p),
		isWithinInnerBounds: (p) => layout.isWithinInnerBounds(p),
		// getActiveAxes: (p) => layout.getActiveAxes.bind(p),
		// getActiveAxes: (p) => layout.getActiveAxes.bind(p),
		getActiveAxes: (p) => layout.getActiveAxes(p),
		reset: () => layout.reset(),
		getDebugInfo: () => layout.getDebugInfo(),

		// Scale coordinator properties - reactive to scales changes
		get xScale() {
			// return scales.xScale?.scale;
			return scales.xScale;
		},
		get yScale() {
			// return scales.yScale?.scale;
			return scales.yScale;
		},
		get xTargetScale() {
			// return scales.xTargetScale?.scale;
			return scales.xTargetScale;
		},
		get yTargetScale() {
			// return scales.yTargetScale?.scale;
			return scales.yTargetScale;
		},

		get xLabel() {
			return scales.xLabel;
		},
		get yLabel() {
			return scales.yLabel;
		},

		get currentXDataPoint() {
			return scales.currentXDataPoint;
		},
		get currentYDataPoint() {
			return scales.currentYDataPoint;
		},
		get currentXScreenPoint() {
			return scales.currentXScreenPoint;
		},
		get currentYScreenPoint() {
			return scales.currentYScreenPoint;
		},

		get xScaleState() {
			return scales.xScaleState;
		},
		get yScaleState() {
			return scales.yScaleState;
		},

		get scaleTypes() {
			return scales.scaleTypes;
		},
		get scalesReady() {
			return scales.scalesReady;
		},
		get active() {
			return scales.active;
		},
		get xCategoryPositions() {
			return scales.xCategoryPositions;
		},
		get yCategoryPositions() {
			return scales.yCategoryPositions;
		},
		get categoryPositionsReady() {
			return scales.categoryPositionsReady;
		},
		get xBandwidth() {
			return scales.xBandwidth;
		},
		get yBandwidth() {
			return scales.yBandwidth;
		},

		// Scale coordinator methods
		registerScaleType: (dimension, type, priority, markId, config, columnName) =>
			scales.registerScaleType(dimension, type, priority, markId, config, columnName),
		unregisterScaleType: (dimension, markId) => scales.unregisterScaleType(dimension, markId),
		getScaleRequirementsSummary: () => scales.getScaleRequirementsSummary(),

		// Bin step multiplier for adaptive resolution
		get binStepMultiplier() {
			return scales.binStepMultiplier;
		},

		// Client registration for crossfilter exclusion
		registerClient(client) {
			if (!client) return () => {};
			markClients.add(client);
			return () => markClients.delete(client);
		},
		get markClients() {
			return markClients;
		},

		// Tooltip manager
		get tooltipManager() {
			return tooltipManager;
		}
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

	function handleChartPointerEnter() {
		gpuCoordinator.setChartHovered(layout.chartId);
		wheelControl.handlePointerEnter();
	}

	function handleChartPointerLeave() {
		gpuCoordinator.setChartUnhovered(layout.chartId);
		wheelControl.handlePointerLeave();
		tooltipManager?.updatePosition(null, null);
	}

	// ZOOM HANDLERS
	function handleWheel(event) {
		// Check if wheel should be captured for chart interaction
		if (!wheelControl.shouldCaptureWheel(event)) {
			return; // Let event propagate for page scroll
		}

		event.preventDefault();

		// Shift+Wheel controls bin density
		if (event.shiftKey) {
			// Scroll UP (negative delta) = Increase density by 5%
			// Scroll DOWN (positive delta) = Decrease density by 5%
			const delta = event.deltaY < 0 ? 0.05 : -0.05;
			scales.adjustBinMultiplier(delta);
			return;
		}

		pointerBuffer.x = event.offsetX;
		pointerBuffer.y = event.offsetY;

		const { xInBounds, yInBounds, innerPoint } = layout.getActiveAxes(pointerBuffer);

		const scaleFactor =
			event.deltaY < 0 ? 1 + Math.abs(event.deltaY) * 0.0025 : 1 - Math.abs(event.deltaY) * 0.0025;

		scales.accumulateZoom(innerPoint, scaleFactor, xInBounds, yInBounds);
		tooltipManager?.suppress(100);
	}

	function handleDoubleClick(event) {
		event.preventDefault();
		pointerBuffer.x = event.offsetX;
		pointerBuffer.y = event.offsetY;
		const { xInBounds, yInBounds } = layout.getActiveAxes(pointerBuffer);
		scales.resetZoom(xInBounds, yInBounds);
		tooltipManager?.suppress(300);
	}

	// TOUCH HANDLERS
	// function getTouchDistance(touches) {
	// 	if (touches.length < 2) return 0;
	// 	const dx = touches[0].clientX - touches[1].clientX;
	// 	const dy = touches[0].clientY - touches[1].clientY;
	// 	return Math.sqrt(dx * dx + dy * dy);
	// }

	function getTouchDistance(t1, t2) {
		const dx = t1.clientX - t2.clientX;
		const dy = t1.clientY - t2.clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	function handleTouchStart(event) {
		if (event.touches.length === 2) {
			event.preventDefault();
			isZooming = true;
			// Access indices directly, don't convert List to Array
			initialTouchDistance = getTouchDistance(event.touches[0], event.touches[1]);

			pointerBuffer.x = event.offsetX;
			pointerBuffer.y = event.offsetY;

			const { xInBounds, yInBounds } = layout.getActiveAxes(pointerBuffer);
			activePanX = xInBounds;
			activePanY = yInBounds;
		}
	}

	function handleTouchMove(event) {
		if (!isZooming || event.touches.length !== 2) return;

		const currentDistance = getTouchDistance(event.touches[0], event.touches[1]);
		const scaleFactor = currentDistance / initialTouchDistance;

		if (Math.abs(scaleFactor - 1) > 0.01) {
			pointerBuffer.x = event.offsetX;
			pointerBuffer.y = event.offsetY;
			const { innerPoint } = layout.getActiveAxes(pointerBuffer);

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
	// function handlePointerDown(event) {
	// 	event.preventDefault();

	// 	const point = { x: event.offsetX, y: event.offsetY };
	// 	const { x, y, innerPoint } = layout.getActiveAxes(point);

	// 	// Only allow panning on linear scales
	// 	activePanX = x && scales.scaleTypes?.x === 'linear';
	// 	activePanY = y && scales.scaleTypes?.y === 'linear';

	// 	// Only proceed if at least one axis can pan
	// 	if (!activePanX && !activePanY) {
	// 		return;
	// 	}
	// 	isPanning = true;

	// 	scales.startPan({ x: event.offsetX, y: event.offsetY }, activePanX, activePanY);

	// 	scales.clearCurrentDataPoints();
	// 	event.target.setPointerCapture?.(event.pointerId);
	// }

	function handlePointerDown(event) {
		event.preventDefault();

		// Test force focus
		if (event.target.focus) {
			event.target.focus({ preventScroll: true });
		}

		pointerBuffer.x = event.offsetX;
		pointerBuffer.y = event.offsetY;

		const { xInBounds, yInBounds, innerPoint } = layout.getActiveAxes(pointerBuffer);

		const xType = scales.scaleTypes?.x;
		const yType = scales.scaleTypes?.y;
		activePanX = xInBounds && (xType === 'linear' || xType === 'time');
		activePanY = yInBounds && (yType === 'linear' || yType === 'time');

		if (!activePanX && !activePanY) return;

		isPanning = true;

		// Pass primitives to startPan
		scales.startPan(pointerBuffer.x, pointerBuffer.y, activePanX, activePanY);

		scales.clearCurrentDataPoints();
		event.target.setPointerCapture?.(event.pointerId);
	}

	// function handlePointerMove(event) {
	// 	// Single consolidated handler
	// 	if (isPanning) {
	// 		const coalescedEvents = event.getCoalescedEvents?.() || [event];
	// 		scales.updatePanPositionWithCoalescing(coalescedEvents);
	// 	} else {
	// 		// Check if we're in the interactive inner area
	// 		const point = { x: event.offsetX, y: event.offsetY };
	// 		if (layout.isWithinInnerBounds(point)) {
	// 			const innerPoint = layout.toInnerCoordinates(point);
	// 			scales.updateCurrentDataPoints(innerPoint);
	// 		}
	// 	}
	// }

	function processPointerMove(event) {
		if (isPanning) {
			scales.updatePanPosition(event.offsetX, event.offsetY);
			tooltipManager?.suppress(150);
		} else {
			pointerBuffer.x = event.offsetX;
			pointerBuffer.y = event.offsetY;

			if (layout.isWithinInnerBounds(pointerBuffer)) {
				const innerPoint = layout.toInnerCoordinates(pointerBuffer);
				scales.updateCurrentDataPoints(innerPoint);
				tooltipManager?.updatePointerScreen(event.offsetX, event.offsetY);
				tooltipManager?.updatePosition(
					scales.currentXDataPoint,
					scales.currentYDataPoint
				);
			}
		}
	}

	function handlePointerMove(event) {
		// Skip if pointerrawupdate is handling it
		if (hasPointerRawUpdate) return;
		processPointerMove(event);
	}

	// function handlePointerRawUpdate(event) {
	// 	const events = event.getCoalescedEvents?.() ?? [event];
	// 	const last = events[events.length - 1];
	// 	processPointerMove(last);
	// }
	function handlePointerRawUpdate(event) {
		processPointerMove(event);
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
		tooltipManager?.updatePosition(null, null);
	}

	// let testRenderLoop;

	$effect(() => {
		if (chartContext) {
			console.log('📐 Chart dimensions:', {
				innerHeight: chartContext.innerHeight,
				innerWidth: chartContext.innerWidth,
				margin: chartContext.margin
			});
		}
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="chart-container"
	bind:clientWidth={layout.width}
	bind:clientHeight={layout.height}
	onpointerenter={handleChartPointerEnter}
	onpointerleave={handleChartPointerLeave}
>
	{#if layout.isReady}
		<svg class="svg-background" width={layout.width} height={layout.height}>
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
			onpointerrawupdate={handlePointerRawUpdate}
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
				onpointerenter={handleInnerMouseEnter}
				onpointerleave={handleInnerMouseLeave}
			>
				{@render foreground?.()}
				<HoverIndicator />
				<rect
					x="0"
					y="0"
					width={layout.innerWidth}
					height={layout.innerHeight}
					fill="transparent"
					class="interaction-target"
				/>
				{@render interactors?.()}
			</g>
		</svg>
		<!-- Overlay layer - on top of everything, outside SVG -->
		{#if overlay}
			<div class="overlay-layer">
				{@render overlay()}
			</div>
		{/if}

		<!-- Tooltip -->
		{#if tooltipManager}
			<Tooltip />
		{/if}
	{/if}
</div>

<!-- <pre id="info">cpuTime: {gpuCoordinator.timings.cpu}
fps: {gpuCoordinator.timings.fps}
gpu: {gpuCoordinator.timings.gpu} µs
</pre> -->

<style>
	.chart-container {
		position: relative;
		flex: 1;
		height: 100%;
		/* Use 'strict' contain for maximum isolation */
		contain: strict;
		touch-action: none;
		overscroll-behavior: none;
		/* Force GPU layer */
		transform: translateZ(0);
		will-change: transform;
		outline: none;
		/* Prevent paint from bleeding */
		isolation: isolate;
	}

	.svg-background,
	.canvas-layer,
	.svg-foreground {
		position: absolute;
		top: 0;
		left: 0;
		touch-action: none;
	}

	.svg-background {
		z-index: 1;
	}

	.interaction-target {
		/* Ensure it catches all pointer events */
		pointer-events: all;
	}

	.canvas-layer {
		z-index: 2;
		width: 100%;
		height: 100%;
		contain: strict;
		will-change: transform;
	}

	.svg-foreground {
		z-index: 3;
	}

	.crosshair {
		cursor: crosshair;
	}

	.overlay-layer {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		z-index: 10;
		pointer-events: none;
	}

	.overlay-layer :global(*) {
		pointer-events: auto;
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
