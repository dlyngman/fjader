<script lang="ts">
	import { setContext, getContext, onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import { ChartLayout } from '$lib/layout/ChartLayout.svelte';
	import type { Margin } from '$lib/types';
	import { WheelInteractionControl } from '$lib/utils/wheelInteractionControl';
	import { TooltipManager } from '$lib/interactors/TooltipManager.svelte';
	import type { ChartContext, Coordinator } from '$lib/types';
	import type { ChartScales } from '$lib/scales/ChartScales.svelte';
	import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import Tooltip from '$lib/interactors/Tooltip.svelte';
	import HoverIndicator from '$lib/interactors/HoverIndicator.svelte';
	import WebGPUCanvas from '$lib/components/rendering/WebGPUCanvas.svelte';

	interface FacetingProps {
		fx: string | null;
		isFaceted: boolean;
		facetChartIds: string[];
		facetBandScale: BandScaleState | null;
	}

	interface WheelInteractionConfig {
		dwellTimeMs?: number;
		momentumThreshold?: number;
		enabled?: boolean;
	}

	interface Props {
		cellChartId: string;
		facetIndex?: number | null;
		facetLabel?: string | null;
		margin?: Margin;
		height?: number;
		scales: ChartScales;
		facetingProps?: FacetingProps;
		gpuCoordinator: GPUCoordinator;
		coordinator: Coordinator;
		wheelInteraction?: WheelInteractionConfig;
		background?: Snippet;
		foreground?: Snippet;
		canvas?: Snippet;
		canvasComponents?: Snippet;
		interactors?: Snippet;
		overlay?: Snippet;
	}

	let {
		cellChartId,
		facetIndex = null,
		facetLabel = null,
		margin = { top: 30, right: 50, bottom: 35, left: 75 },
		height = 250,
		scales,
		facetingProps = { fx: null, isFaceted: false, facetChartIds: [], facetBandScale: null },
		gpuCoordinator,
		coordinator,
		wheelInteraction = { dwellTimeMs: 250, momentumThreshold: 150, enabled: true },
		background = undefined,
		foreground = undefined,
		canvas = undefined,
		canvasComponents = undefined,
		interactors = undefined,
		overlay = undefined
	}: Props = $props();

	// --- Layout ---
	const layout = new ChartLayout({ margin, height });
	layout.chartId = cellChartId;

	// Track container dimensions
	let containerWidth = $state(0);
	let containerHeight = $state(0);

	// Store inner screen coordinates directly from pointer events.
	// Avoids the screen→data→screen round-trip for crosshair/MarginLabel positioning,
	// which can desync when the animation loop advances the scale domain between
	// the event handler (inversion) and the Svelte render pass (forward mapping).
	let currentInnerX = $state<number | null>(null);
	let currentInnerY = $state<number | null>(null);

	$effect(() => {
		if (containerWidth > 0) layout.updateWidth(containerWidth);
	});
	$effect(() => {
		if (containerHeight > 0) layout.updateHeight(containerHeight);
	});

	// --- Cell-local D3 scales (cached via $derived) ---
	const cellXScale = $derived.by(() => {
		const ss = scales?.xScaleState;
		if (!layout.isReady || !ss) return null;
		ss.domainForReactivity;
		return ss.updateScaleDomain(ss.getBaseScale('x', layout.innerWidth));
	});

	const cellYScale = $derived.by(() => {
		const ss = scales?.yScaleState;
		if (!layout.isReady || !ss) return null;
		ss.domainForReactivity;
		return ss.updateScaleDomain(ss.getBaseScale('y', layout.innerHeight));
	});

	const cellXTargetScale = $derived.by(() => {
		const ss = scales?.xScaleState;
		if (!layout.isReady || !ss) return null;
		ss.domainForReactivity;
		return ss.updateScaleDomain(ss.getBaseScale('x', layout.innerWidth), false);
	});

	const cellYTargetScale = $derived.by(() => {
		const ss = scales?.yScaleState;
		if (!layout.isReady || !ss) return null;
		ss.domainForReactivity;
		return ss.updateScaleDomain(ss.getBaseScale('y', layout.innerHeight), false);
	});

	// --- Band scale support (cell-local $derived) ---
	const xCategoryPositions = $derived.by(() => {
		if (scales?.scaleTypes?.x !== 'band' || !cellXScale || !layout.isReady) return null;
		const domain = scales.xScaleState?.effectiveDomain;
		if (!domain || domain.length === 0) return null;
		return new Float32Array(domain.map((d) => cellXScale(d)));
	});

	const yCategoryPositions = $derived.by(() => {
		if (scales?.scaleTypes?.y !== 'band' || !cellYScale || !layout.isReady) return null;
		const domain = scales.yScaleState?.effectiveDomain;
		if (!domain || domain.length === 0) return null;
		return new Float32Array(domain.map((d) => cellYScale(d)));
	});

	const categoryPositionsReady = $derived.by(() => {
		const xReady = scales?.scaleTypes?.x !== 'band' || xCategoryPositions !== null;
		const yReady = scales?.scaleTypes?.y !== 'band' || yCategoryPositions !== null;
		return xReady && yReady;
	});

	const xBandwidth = $derived.by(() => {
		if (scales?.scaleTypes?.x !== 'band' || !cellXScale || !layout.isReady) return 0;
		return cellXScale.bandwidth?.() ?? 0;
	});

	const yBandwidth = $derived.by(() => {
		if (scales?.scaleTypes?.y !== 'band' || !cellYScale || !layout.isReady) return 0;
		return cellYScale.bandwidth?.() ?? 0;
	});

	// --- Tooltip ---
	const isFacetedCell = facetIndex != null;
	let tooltipManager = $state<TooltipManager | null>(null);

	$effect(() => {
		if (!scales || !coordinator || isFacetedCell) return;

		const scaleProvider = {
			get xScale() {
				return cellXScale;
			},
			get yScale() {
				return cellYScale;
			},
			get xScaleState() {
				return scales.xScaleState;
			},
			get yScaleState() {
				return scales.yScaleState;
			}
		};

		const tm = new TooltipManager(coordinator, scaleProvider);
		tooltipManager = tm;

		const frameCallback = () => tm.tick();
		gpuCoordinator.addFrameCallback(frameCallback);

		return () => {
			gpuCoordinator.removeFrameCallback(frameCallback);
			tm.destroy();
		};
	});

	// --- Scale readiness effect ---
	$effect(() => {
		const xScale = scales?.xScaleState;
		const yScale = scales?.yScaleState;

		if (xScale && yScale && layout.isReady) {
			const xHasDomain = xScale.hasDomain ?? xScale.effectiveDomain?.length > 0;
			const yHasDomain = yScale.hasDomain ?? yScale.effectiveDomain?.length > 0;

			if (!xScale.ready && xHasDomain) {
				xScale.setReady?.();
			}
			if (!yScale.ready && yHasDomain) {
				yScale.setReady?.();
			}

			if (xScale.ready && yScale.ready) {
				gpuCoordinator.invalidateChart(layout.chartId);
			}
		}
	});

	// --- Chart context ---
	const chartContext: ChartContext = {
		// Layout — cell-specific
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

		updateWidth: (w) => layout.updateWidth(w),
		updateHeight: (h) => layout.updateHeight(h),
		updateMargin: (m) => layout.updateMargin(m),
		toInnerCoordinates: (p) => layout.toInnerCoordinates(p),
		toScreenCoordinates: (p) => layout.toScreenCoordinates(p),
		isWithinInnerBounds: (p) => layout.isWithinInnerBounds(p),
		getActiveAxes: (p) => layout.getActiveAxes(p),
		reset: () => layout.reset(),
		getDebugInfo: () => layout.getDebugInfo(),

		// D3 scales — cell-local (cached $derived)
		// Read domainForReactivity so template expressions track _version (domain changes).
		// Read layout dimensions so template expressions also track range changes (resize).
		// Without these, $derived returns the same D3 scale reference (mutated in place)
		// and Svelte's === check considers it unchanged, skipping axis tick updates.
		get xScale() {
			scales?.xScaleState?.domainForReactivity;
			layout.innerWidth;
			return cellXScale;
		},
		get yScale() {
			scales?.yScaleState?.domainForReactivity;
			layout.innerHeight;
			return cellYScale;
		},
		get xTargetScale() {
			scales?.xScaleState?.domainForReactivity;
			layout.innerWidth;
			return cellXTargetScale;
		},
		get yTargetScale() {
			scales?.yScaleState?.domainForReactivity;
			layout.innerHeight;
			return cellYTargetScale;
		},

		get xLabel() {
			return scales?.xLabel;
		},
		get yLabel() {
			return scales?.yLabel;
		},

		// Data points — from shared scale state
		get currentXDataPoint() {
			return scales?.xScaleState?.currentDataPoint;
		},
		get currentYDataPoint() {
			return scales?.yScaleState?.currentDataPoint;
		},
		get currentXScreenPoint() {
			return currentInnerX;
		},
		get currentYScreenPoint() {
			return currentInnerY;
		},

		// Scale states + types — shared
		get xScaleState() {
			return scales?.xScaleState;
		},
		get yScaleState() {
			return scales?.yScaleState;
		},
		get scaleTypes() {
			return scales?.scaleTypes;
		},
		get scalesReady() {
			return scales?.scalesReady;
		},
		get active() {
			return scales?.active;
		},

		// Band support — cell-local $derived
		get xCategoryPositions() {
			return xCategoryPositions;
		},
		get yCategoryPositions() {
			return yCategoryPositions;
		},
		get categoryPositionsReady() {
			return categoryPositionsReady;
		},
		get xBandwidth() {
			return xBandwidth;
		},
		get yBandwidth() {
			return yBandwidth;
		},

		// Scale registration — delegate to ChartScales
		registerScaleType: (dimension, type, priority, markId, config, columnName) =>
			scales?.registerScaleType(dimension, type, priority, markId, config, columnName),
		unregisterScaleType: (dimension, markId) => scales?.unregisterScaleType(dimension, markId),
		getScaleRequirementsSummary: () => scales?.getScaleRequirementsSummary(),

		get binStepMultiplier() {
			return scales?.binStepMultiplier;
		},

		// Client registration
		registerClient(client) {
			if (!client || !scales) return () => {};
			return scales.registerClient(client);
		},
		get markClients() {
			return scales?.markClients;
		},

		// Tooltip — cell-local
		get tooltipManager() {
			return tooltipManager;
		},

		// Faceting — from parent
		fx: facetingProps.fx,
		get isFaceted() {
			return facetingProps.isFaceted;
		},
		get facetChartIds() {
			return facetingProps.facetChartIds;
		},
		get facetBandScale() {
			return facetingProps.facetBandScale;
		},

		// Pointer hooks — cell-local (mutable slots set by interactors)
		onChartClick: null,
		onInteractorPointerDown: null,
		onInteractorPointerMove: null,
		onInteractorPointerUp: null,
		onInteractorPointerEnter: null
	};

	setContext('chart', chartContext);

	// --- Pointer event handling ---
	const pointerBuffer = { x: 0, y: 0 };
	const wheelControl = new WheelInteractionControl(wheelInteraction);
	// Disable pointerrawupdate inside iframes (e.g. Streamlit). In Chrome iframes,
	// pointerrawupdate fires at hardware rate (~1000Hz) and creates a timing desync:
	// the animation loop can advance the scale domain between the event handler's
	// screen→data inversion and Svelte's render pass that maps data→screen for the
	// crosshair, breaking the round-trip identity and causing a visible offset.
	// pointermove (coalesced to frame boundaries) does not have this issue.
	const isIframe = typeof window !== 'undefined' && window.self !== window.top;
	const hasPointerRawUpdate =
		typeof window !== 'undefined' && 'onpointerrawupdate' in window && !isIframe;

	let svg = $state<SVGSVGElement>();
	let isPanning = $state(false);
	let activePanX = $state(false);
	let activePanY = $state(false);

	// Touch/pinch zoom state
	let initialTouchDistance = $state(0);
	let isZooming = $state(false);

	function handleChartPointerEnter() {
		gpuCoordinator.setChartHovered(layout.chartId);
		wheelControl.handlePointerEnter();
	}

	function handleChartPointerLeave() {
		gpuCoordinator.setChartUnhovered(layout.chartId);
		wheelControl.handlePointerLeave();
		tooltipManager?.updatePosition(null, null);
	}

	function handleWheel(event: WheelEvent) {
		if (!wheelControl.shouldCaptureWheel(event)) return;
		event.preventDefault();

		if (event.shiftKey) {
			const delta = event.deltaY < 0 ? 0.05 : -0.05;
			scales.adjustBinMultiplier(delta);
			return;
		}

		pointerBuffer.x = event.offsetX;
		pointerBuffer.y = event.offsetY;
		const { xInBounds, yInBounds, innerPoint } = layout.getActiveAxes(pointerBuffer);
		const scaleFactor =
			event.deltaY < 0 ? 1 + Math.abs(event.deltaY) * 0.0025 : 1 - Math.abs(event.deltaY) * 0.0025;
		scales.accumulateZoom(
			innerPoint,
			scaleFactor,
			xInBounds,
			yInBounds,
			layout.innerWidth,
			layout.innerHeight
		);
		tooltipManager?.suppress(100);
	}

	function handleClick(event: MouseEvent) {
		chartContext.onChartClick?.(event);
	}

	function handleDoubleClick(event: MouseEvent) {
		event.preventDefault();
		pointerBuffer.x = event.offsetX;
		pointerBuffer.y = event.offsetY;
		const { xInBounds, yInBounds } = layout.getActiveAxes(pointerBuffer);
		scales.resetZoom(xInBounds, yInBounds);
		tooltipManager?.suppress(300);
	}

	function getTouchDistance(t1: Touch, t2: Touch): number {
		const dx = t1.clientX - t2.clientX;
		const dy = t1.clientY - t2.clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	function handleTouchStart(event: TouchEvent) {
		if (event.touches.length === 2) {
			event.preventDefault();
			isZooming = true;
			initialTouchDistance = getTouchDistance(event.touches[0], event.touches[1]);
			pointerBuffer.x = event.offsetX;
			pointerBuffer.y = event.offsetY;
			const { xInBounds, yInBounds } = layout.getActiveAxes(pointerBuffer);
			activePanX = xInBounds;
			activePanY = yInBounds;
		}
	}

	function handleTouchMove(event: TouchEvent) {
		if (!isZooming || event.touches.length !== 2) return;
		const currentDistance = getTouchDistance(event.touches[0], event.touches[1]);
		const scaleFactor = currentDistance / initialTouchDistance;

		if (Math.abs(scaleFactor - 1) > 0.01) {
			pointerBuffer.x = event.offsetX;
			pointerBuffer.y = event.offsetY;
			const { innerPoint } = layout.getActiveAxes(pointerBuffer);
			scales.applyZoom(
				innerPoint,
				scaleFactor,
				activePanX,
				activePanY,
				layout.innerWidth,
				layout.innerHeight
			);
			initialTouchDistance = currentDistance;
		}
	}

	function handleTouchEnd() {
		isZooming = false;
		isPanning = false;
		activePanX = false;
		activePanY = false;
	}

	function handlePointerDown(event: PointerEvent) {
		event.preventDefault();
		if (event.target.focus) event.target.focus({ preventScroll: true });

		pointerBuffer.x = event.offsetX;
		pointerBuffer.y = event.offsetY;
		const { xInBounds, yInBounds, innerPoint } = layout.getActiveAxes(pointerBuffer);

		if (xInBounds && yInBounds && chartContext.onInteractorPointerDown?.(event, innerPoint)) return;

		const xType = scales.scaleTypes?.x;
		const yType = scales.scaleTypes?.y;
		activePanX = xInBounds && (xType === 'linear' || xType === 'time');
		activePanY = yInBounds && (yType === 'linear' || yType === 'time');

		if (!activePanX && !activePanY) return;
		isPanning = true;
		scales.startPan(
			pointerBuffer.x,
			pointerBuffer.y,
			activePanX,
			activePanY,
			layout.innerWidth,
			layout.innerHeight
		);
		scales.clearCurrentDataPoints();
		currentInnerX = null;
		currentInnerY = null;
		event.target.setPointerCapture?.(event.pointerId);
	}

	function processPointerMove(event: PointerEvent) {
		if (isPanning) {
			scales.updatePanPosition(event.offsetX, event.offsetY);
			tooltipManager?.suppress(150);
		} else if (chartContext.onInteractorPointerMove?.(event)) {
			tooltipManager?.suppress(100);
		} else {
			pointerBuffer.x = event.offsetX;
			pointerBuffer.y = event.offsetY;

			if (layout.isWithinInnerBounds(pointerBuffer)) {
				const innerPoint = layout.toInnerCoordinates(pointerBuffer);
				currentInnerX = innerPoint.x;
				currentInnerY = innerPoint.y;
				scales.updateCurrentDataPoints(innerPoint, layout.innerWidth, layout.innerHeight);
				tooltipManager?.updatePointerScreen(event.offsetX, event.offsetY);
				tooltipManager?.updatePosition(
					scales.xScaleState?.currentDataPoint,
					scales.yScaleState?.currentDataPoint
				);
			}
		}
	}

	function handlePointerMove(event: PointerEvent) {
		if (hasPointerRawUpdate) return;
		processPointerMove(event);
	}

	function handlePointerRawUpdate(event: PointerEvent) {
		processPointerMove(event);
	}

	function handlePointerUp(event: PointerEvent) {
		if (chartContext.onInteractorPointerUp?.(event)) return;
		isPanning = false;
		activePanX = false;
		activePanY = false;
		event.target.releasePointerCapture?.(event.pointerId);
		scales.endPan();
	}

	function handleInnerMouseEnter() {
		scales.active = true;
		chartContext.onInteractorPointerEnter?.();
	}

	function handleInnerMouseLeave() {
		scales.clearCurrentDataPoints();
		currentInnerX = null;
		currentInnerY = null;
		scales.active = false;
		tooltipManager?.updatePosition(null, null);
	}

	// Layout readiness — marks must render before scales become ready (they register scale types).
	// Don't gate on scalesReady here — that creates a chicken-and-egg deadlock in non-faceted mode.
	const cellReady = $derived(layout.isReady);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="chart-cell"
	bind:clientWidth={containerWidth}
	bind:clientHeight={containerHeight}
	onpointerenter={handleChartPointerEnter}
	onpointerleave={handleChartPointerLeave}
>
	{#if facetLabel != null}
		<div class="facet-label">{facetLabel}</div>
	{/if}

	<div class="cell-content">
		{#if cellReady}
			<svg class="svg-background" width={layout.width} height={layout.height}>
				<g transform={layout.innerTransform}>
					{@render background?.()}
				</g>
			</svg>

			<div class="canvas-layer">
				{#if canvas}
					{@render canvas()}
				{:else}
					<WebGPUCanvas {facetIndex} />
				{/if}
			</div>

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
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
				onclick={handleClick}
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

			{#if overlay}
				<div class="overlay-layer">
					{@render overlay()}
				</div>
			{/if}

			{#if tooltipManager}
				<Tooltip />
			{/if}
		{/if}
	</div>
</div>

<style>
	.chart-cell {
		position: relative;
		flex: 1;
		min-height: 0;
		contain: strict;
		touch-action: none;
		overscroll-behavior: none;
		transform: translateZ(0);
		will-change: transform;
		outline: none;
		isolation: isolate;
	}

	.facet-label {
		text-align: center;
		font-family: var(--diveplot-font, system-ui, sans-serif);
		font-size: 12px;
		font-weight: 500;
		color: var(--diveplot-text-secondary, #6b7280);
		padding: 4px 0;
		flex-shrink: 0;
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 5;
		pointer-events: none;
	}

	.cell-content {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
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
</style>
