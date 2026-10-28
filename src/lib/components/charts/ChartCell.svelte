<script lang="ts">
	import { setContext, getContext, onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import { ChartLayout } from '$lib/layout/ChartLayout.svelte';
	import type { Margin } from '$lib/types';
	import { WheelInteractionControl } from '$lib/interactors/wheelInteractionControl';
	import { TooltipManager } from '$lib/interactors/TooltipManager.svelte';
	import type { ChartContext, FieldRef } from '$lib/types';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { ChartScales } from '$lib/scales/ChartScales.svelte';
	import type { ChartConfig } from '$lib/config';
	import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { DimValue } from '$lib/query-engine/categorical-identity';
	import type { D3Scale } from '$lib/types';
	import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import { HoverSettle } from './hover-settle';
	import Tooltip from '$lib/interactors/Tooltip.svelte';
	import HoverIndicator from '$lib/interactors/HoverIndicator.svelte';
	import CommandPalette from '$lib/interactors/CommandPalette.svelte';
	import WebGPUCanvas from '$lib/components/rendering/WebGPUCanvas.svelte';

	interface FacetingProps {
		/** A column name or a fixed SQL expression. See ChartContainer's fx prop. */
		fx: FieldRef | null;
		fxDomain?: DimValue[] | null;
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
		clipPadding?: number;
		scales: ChartScales;
		chartConfig: ChartConfig;
		facetingProps?: FacetingProps;
		gpuCoordinator: GPUCoordinator;
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
		clipPadding = 0,
		scales,
		chartConfig,
		facetingProps = {
			fx: null,
			fxDomain: null,
			isFaceted: false,
			facetChartIds: [],
			facetBandScale: null
		},
		gpuCoordinator,
		wheelInteraction = { dwellTimeMs: 250, momentumThreshold: 150, enabled: true },
		background = undefined,
		foreground = undefined,
		canvas = undefined,
		canvasComponents = undefined,
		interactors = undefined,
		overlay = undefined
	}: Props = $props();

	const queryEngine = getContext<QueryEngine>('query-engine');

	// --- Layout ---
	const layout = new ChartLayout({ margin, height, clipPadding });
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
	let paletteOpen = $state(false);

	$effect(() => {
		if (containerWidth > 0) layout.updateWidth(containerWidth);
	});
	$effect(() => {
		if (containerHeight > 0) layout.updateHeight(containerHeight);
	});
	// Sync layout margins from chart-level palette overrides
	$effect(() => {
		const cp = chartConfig.chartProps;
		layout.updateMargin({
			top: cp?.marginTop ?? margin.top,
			right: cp?.marginRight ?? margin.right,
			bottom: cp?.marginBottom ?? margin.bottom,
			left: cp?.marginLeft ?? margin.left
		});
	});

	// --- Cell-local D3 scales (cached via $derived) ---
	// Each cell owns its own D3 scale copies so that vconcat charts sharing
	// the same scale state don't overwrite each other's range via the shared
	// internal scale object. Copies are only created when the scale state
	// identity changes (rare); range/domain updates are in-place (zero-alloc).
	let ownXScale: D3Scale | null = null;
	let ownXSource: unknown = null;
	let ownYScale: D3Scale | null = null;
	let ownYSource: unknown = null;

	const cellXScale = $derived.by((): D3Scale | null => {
		const ss = scales?.xScaleState;
		if (!layout.isReady || !ss) return null;
		ss.domainForReactivity;
		if (ownXSource !== ss) {
			ownXScale = (ss.getBaseScale('x', layout.innerWidth) as D3Scale & { copy(): D3Scale }).copy();
			ownXSource = ss;
		}
		ownXScale!.range([0, layout.innerWidth]);
		return ss.updateScaleDomain(ownXScale!) as D3Scale;
	});

	const cellYScale = $derived.by((): D3Scale | null => {
		const ss = scales?.yScaleState;
		if (!layout.isReady || !ss) return null;
		ss.domainForReactivity;
		if (ownYSource !== ss) {
			ownYScale = (
				ss.getBaseScale('y', layout.innerHeight) as D3Scale & { copy(): D3Scale }
			).copy();
			ownYSource = ss;
		}
		ownYScale!.range([layout.innerHeight, 0]);
		return ss.updateScaleDomain(ownYScale!) as D3Scale;
	});

	const cellXTargetScale = $derived.by((): D3Scale | null => {
		const ss = scales?.xScaleState;
		if (!layout.isReady || !ss) return null;
		ss.domainForReactivity;
		// Target scales can reuse the same cell-local copy since they read the same state
		if (ownXSource !== ss) {
			ownXScale = (ss.getBaseScale('x', layout.innerWidth) as D3Scale & { copy(): D3Scale }).copy();
			ownXSource = ss;
		}
		ownXScale!.range([0, layout.innerWidth]);
		return ss.updateScaleDomain(ownXScale!) as D3Scale;
	});

	const cellYTargetScale = $derived.by((): D3Scale | null => {
		const ss = scales?.yScaleState;
		if (!layout.isReady || !ss) return null;
		ss.domainForReactivity;
		if (ownYSource !== ss) {
			ownYScale = (
				ss.getBaseScale('y', layout.innerHeight) as D3Scale & { copy(): D3Scale }
			).copy();
			ownYSource = ss;
		}
		ownYScale!.range([layout.innerHeight, 0]);
		return ss.updateScaleDomain(ownYScale!) as D3Scale;
	});

	// --- Band scale support (cell-local $derived) ---
	const xBandwidth = $derived.by(() => {
		if (scales?.scaleTypes?.x !== 'band' || !cellXScale || !layout.isReady) return 0;
		return cellXScale?.bandwidth?.() ?? 0;
	});

	const yBandwidth = $derived.by(() => {
		if (scales?.scaleTypes?.y !== 'band' || !cellYScale || !layout.isReady) return 0;
		return cellYScale?.bandwidth?.() ?? 0;
	});

	// --- Tooltip ---
	const isFacetedCell = facetIndex != null;
	let tooltipManager = $state<TooltipManager | null>(null);

	$effect(() => {
		if (!scales || !queryEngine || isFacetedCell) return;

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

		const tm = new TooltipManager(queryEngine, scaleProvider, chartConfig);
		tooltipManager = tm;

		const frameCallback = () => tm.tick();
		gpuCoordinator.addFrameCallback(frameCallback);

		return () => {
			gpuCoordinator.removeFrameCallback(frameCallback);
			tm.destroy();
		};
	});

	// --- Viewport visibility callback (reserved for future use) ---
	const removeVisibilityCallback = gpuCoordinator.setVisibilityCallback(
		layout.chartId,
		(_visible) => {}
	);
	onMount(() => removeVisibilityCallback);
	onMount(() => () => hoverSettle.leave());

	// --- Scale readiness effect ---
	$effect(() => {
		const xScale = scales?.xScaleState;
		const yScale = scales?.yScaleState;

		if (xScale && yScale && layout.isReady) {
			const xHasDomain =
				xScale.scaleType !== 'band' ? xScale.hasDomain : xScale.effectiveDomain.length > 0;
			const yHasDomain =
				yScale.scaleType !== 'band' ? yScale.hasDomain : yScale.effectiveDomain.length > 0;

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
		get xColumnName() {
			return scales?.xColumnName ?? null;
		},
		get yColumnName() {
			return scales?.yColumnName ?? null;
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
		get xBandwidth() {
			return xBandwidth;
		},
		get yBandwidth() {
			return yBandwidth;
		},

		// Scale registration — delegate to ChartScales
		registerScaleType: (dimension, type, priority, markId, config, columnName) =>
			scales?.registerScaleType(dimension as 'x' | 'y', type, priority, markId, config, columnName),
		unregisterScaleType: (dimension, markId) =>
			scales?.unregisterScaleType(dimension as 'x' | 'y', markId),
		registerParallelColumn: (column, markId) => scales?.registerParallelColumn(column, markId),
		unregisterParallelColumn: (column, markId) => scales?.unregisterParallelColumn(column, markId),
		reorderParallelAxis: (from, to) => scales?.reorderParallelAxis(from, to),
		get parallelReorderState() {
			return { dataIdx: scales?.reorderDataIdx ?? null, currentX: scales?.reorderCurrentX ?? null };
		},
		get animatedAxisXPositions() {
			return scales?.animatedAxisXPositions ?? [];
		},
		get parallelScales() {
			return scales?.parallelScales ?? null;
		},
		get binStepMultiplier() {
			return scales?.binStepMultiplier;
		},
		adjustBinMultiplier: (delta: number) => scales?.adjustBinMultiplier(delta),

		// Tooltip — cell-local
		get tooltipManager() {
			return tooltipManager;
		},

		// Faceting — from parent
		fx: facetingProps.fx,
		fxDomain: facetingProps.fxDomain ?? null,
		get isFaceted() {
			return facetingProps.isFaceted;
		},
		get facetChartIds() {
			return facetingProps.facetChartIds;
		},
		get facetBandScale() {
			return facetingProps.facetBandScale;
		},

		// Configuration store — from parent ChartContainer
		config: chartConfig,

		// Pointer hooks — cell-local (mutable slots set by interactors)
		onChartClick: null,
		onInteractorPointerDown: null,
		onInteractorPointerMove: null,
		onInteractorPointerUp: null,
		activators: new Set()
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
	let isReordering = $state(false);

	// Touch/pinch zoom state
	let initialTouchDistance = $state(0);
	let isZooming = $state(false);

	let chartCellEl: HTMLDivElement;
	// SVG offsetX/offsetY is relative to the *target* element, not the listener,
	// so coordinates shift when the pointer crosses the margin ↔ inner boundary.
	// Using clientX/Y minus the SVG's viewport origin avoids this.
	let svgLeft = 0;
	let svgTop = 0;

	function refreshSvgOrigin(): void {
		if (svg) {
			const rect = svg.getBoundingClientRect();
			svgLeft = rect.left;
			svgTop = rect.top;
		}
	}

	function handleChartPointerEnter(event: PointerEvent) {
		activateSources();
		hoverSettle.enter();
		refreshSvgOrigin();
		gpuCoordinator.setChartHovered(layout.chartId);
		wheelControl.handlePointerEnter();
		// Focus so [ / ] keyboard shortcuts work for tooltip cycling.
		// Relax the check: focus unless something inside the chart cell already has focus
		// (e.g., palette input). The strict body/null check fails in iframes (Streamlit)
		// where activeElement is the iframe container or a wrapper div.
		if (!chartCellEl?.contains(document.activeElement)) {
			chartCellEl?.focus({ preventScroll: true });
		}
	}

	function handleChartPointerLeave() {
		hoverSettle.leave();
		gpuCoordinator.setChartUnhovered(layout.chartId);
		wheelControl.handlePointerLeave();
		tooltipManager?.updatePosition(null, null);
	}

	/** Pointer x relative to SVG root. */
	function ptrX(event: { clientX: number }): number {
		return event.clientX - svgLeft;
	}
	/** Pointer y relative to SVG root. */
	function ptrY(event: { clientY: number }): number {
		return event.clientY - svgTop;
	}

	function handleWheel(event: WheelEvent) {
		if (!wheelControl.shouldCaptureWheel(event)) return;
		event.preventDefault();

		if (event.shiftKey) {
			// Per-mark routing via rung-based API
			const lodSurface = tooltipManager?.currentMarkLOD;
			if (lodSurface) {
				lodSurface.adjustResolution(event.deltaY);
			} else {
				// Fallback: chart-level bin multiplier
				const delta = event.deltaY < 0 ? 0.035 : -0.035;
				scales.adjustBinMultiplier(delta);
			}
			return;
		}

		pointerBuffer.x = ptrX(event);
		pointerBuffer.y = ptrY(event);
		const { xInBounds, yInBounds, innerPoint } = layout.getActiveAxes(pointerBuffer);
		const scaleFactor =
			event.deltaY < 0 ? 1 + Math.abs(event.deltaY) * 0.0025 : 1 - Math.abs(event.deltaY) * 0.0025;
		// Parallel axis zoom takes priority — yInBounds is sufficient (same margin logic as regular axes)
		if (
			yInBounds &&
			!!scales.parallelScales &&
			scales.zoomParallelAxis(
				innerPoint.x,
				innerPoint.y,
				scaleFactor,
				layout.innerWidth,
				layout.innerHeight
			)
		) {
			// handled by parallel axis
		} else {
			scales.accumulateZoom(
				innerPoint,
				scaleFactor,
				xInBounds,
				yInBounds,
				layout.innerWidth,
				layout.innerHeight
			);
		}
		tooltipManager?.suppress(100);
	}

	function handleClick(event: MouseEvent) {
		chartContext.onChartClick?.(event as unknown as PointerEvent);
	}

	function handleContextMenu(event: MouseEvent) {
		event.preventDefault();
		paletteOpen = !paletteOpen;
	}

	function handleKeyDown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
			event.preventDefault();
			paletteOpen = !paletteOpen;
			return;
		}
		if (!tooltipManager?.visible || tooltipManager.currentPoints.length <= 1) return;
		if (event.code === 'BracketRight') {
			event.preventDefault();
			tooltipManager.cycleFocused(1);
		} else if (event.code === 'BracketLeft') {
			event.preventDefault();
			tooltipManager.cycleFocused(-1);
		}
	}

	function handleDoubleClick(event: MouseEvent) {
		event.preventDefault();
		pointerBuffer.x = ptrX(event);
		pointerBuffer.y = ptrY(event);
		const { xInBounds, yInBounds, innerPoint } = layout.getActiveAxes(pointerBuffer);
		if (
			!(yInBounds && !!scales.parallelScales) ||
			!scales.resetParallelZoom(innerPoint.x, layout.innerWidth)
		) {
			scales.resetZoom(xInBounds, yInBounds);
		}
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
			const mid = touchMidpoint(event.touches[0], event.touches[1]);
			pointerBuffer.x = mid.x;
			pointerBuffer.y = mid.y;
			const { xInBounds, yInBounds } = layout.getActiveAxes(pointerBuffer);
			activePanX = xInBounds;
			activePanY = yInBounds;
		}
	}

	function touchMidpoint(t1: Touch, t2: Touch): { x: number; y: number } {
		return {
			x: (t1.clientX + t2.clientX) / 2 - svgLeft,
			y: (t1.clientY + t2.clientY) / 2 - svgTop
		};
	}

	function handleTouchMove(event: TouchEvent) {
		if (!isZooming || event.touches.length !== 2) return;
		const currentDistance = getTouchDistance(event.touches[0], event.touches[1]);
		const scaleFactor = currentDistance / initialTouchDistance;

		if (Math.abs(scaleFactor - 1) > 0.01) {
			const mid = touchMidpoint(event.touches[0], event.touches[1]);
			pointerBuffer.x = mid.x;
			pointerBuffer.y = mid.y;
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
		hoverSettle.hold(true);
		event.preventDefault();
		chartCellEl?.focus({ preventScroll: true });

		pointerBuffer.x = ptrX(event);
		pointerBuffer.y = ptrY(event);
		const { xInBounds, yInBounds, innerPoint } = layout.getActiveAxes(pointerBuffer);

		// Parallel axes are vertical — yInBounds is sufficient, nearestParallelAxis handles x-proximity.
		// This mirrors how regular charts let margin interactions target the in-bounds axis.
		const parallelInBounds = yInBounds && !!scales.parallelScales;

		if (
			((xInBounds && yInBounds) || parallelInBounds) &&
			chartContext.onInteractorPointerDown?.(event, innerPoint)
		) {
			currentInnerX = null;
			currentInnerY = null;
			scales.clearCurrentDataPoints();
			tooltipManager?.updatePosition(null, null);
			return;
		}

		// Parallel axis pan takes priority (parallel chart's x-scale is for layout, not pan)
		if (
			parallelInBounds &&
			scales.startParallelPan(pointerBuffer.y, innerPoint.x, layout.innerWidth, layout.innerHeight)
		) {
			isPanning = true;
			scales.clearCurrentDataPoints();
			currentInnerX = null;
			currentInnerY = null;
			(event.target as Element | null)?.setPointerCapture?.(event.pointerId);
			return;
		}

		// Parallel axis reorder: pointer in bottom margin near a label
		if (
			!yInBounds &&
			innerPoint.y > 0 &&
			scales.parallelScales &&
			scales.startParallelReorder(innerPoint.x, layout.innerWidth)
		) {
			isReordering = true;
			(event.target as Element | null)?.setPointerCapture?.(event.pointerId);
			return;
		}

		activePanX = xInBounds && !!scales.xScaleState?.supportsPanZoom;
		activePanY = yInBounds && !!scales.yScaleState?.supportsPanZoom;

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
		(event.target as Element | null)?.setPointerCapture?.(event.pointerId);
	}

	function processPointerMove(event: PointerEvent) {
		const x = ptrX(event);
		const y = ptrY(event);
		if (isReordering) {
			const innerX = x - layout.margin.left;
			scales.updateParallelReorder(innerX, layout.innerWidth);
			return;
		}
		if (isPanning) {
			scales.updatePanPosition(x, y);
			tooltipManager?.suppress(150);
		} else if (chartContext.onInteractorPointerMove?.(event)) {
			// Brush move/resize use stopPropagation, bypassing handlePointerDown cleanup.
			// Guard ensures this only runs once on the first captured move.
			if (currentInnerX != null) {
				currentInnerX = null;
				currentInnerY = null;
				scales.clearCurrentDataPoints();
				tooltipManager?.updatePosition(null, null);
			}
		} else {
			pointerBuffer.x = x;
			pointerBuffer.y = y;

			if (layout.isWithinInnerBounds(pointerBuffer)) {
				const innerPoint = layout.toInnerCoordinates(pointerBuffer);
				currentInnerX = innerPoint.x;
				currentInnerY = innerPoint.y;
				scales.updateCurrentDataPoints(innerPoint, layout.innerWidth, layout.innerHeight);
				// Suppress tooltip over brush overlays — crosshair/margin labels stay active
				const overBrush = (event.target as Element)?.closest?.('.brush-overlay');
				if (overBrush) {
					tooltipManager?.updatePosition(null, null);
				} else {
					tooltipManager?.updatePointerScreen(x, y);
					tooltipManager?.updatePosition(
						scales.xScaleState?.currentDataPoint,
						scales.yScaleState?.currentDataPoint
					);
				}
			} else {
				currentInnerX = null;
				currentInnerY = null;
				scales.clearCurrentDataPoints();
				tooltipManager?.updatePosition(null, null);
			}
		}
	}

	function handlePointerMove(event: PointerEvent) {
		if (hasPointerRawUpdate) return;
		processPointerMove(event);
	}

	function handlePointerRawUpdate(event: PointerEvent) {
		if (!hasPointerRawUpdate) return;
		processPointerMove(event);
	}

	function handlePointerUp(event: PointerEvent) {
		hoverSettle.hold(false);
		if (isReordering) {
			isReordering = false;
			(event.target as Element | null)?.releasePointerCapture?.(event.pointerId);
			scales.endParallelReorder();
			return;
		}
		if (chartContext.onInteractorPointerUp?.(event)) return;
		isPanning = false;
		activePanX = false;
		activePanY = false;
		(event.target as Element | null)?.releasePointerCapture?.(event.pointerId);
		scales.endPan();
		scales.endParallelPan();
	}

	function handleInnerMouseEnter() {
		scales.active = true;
		activateSources();
	}

	/**
	 * Re-arms the chart's sources once filters and the view have been quiet while
	 * the pointer stays on it (see HoverSettle). "Held" is reported here, for
	 * every gesture on the chart including its own panning, and also clears on
	 * pointercancel and lost capture, or a lost release would stop re-arming for
	 * the rest of the session.
	 */
	const hoverSettle = new HoverSettle({
		filterInterval: 200,
		viewInterval: 100,
		tick: 50,
		lastFilterChangeAt: () => queryEngine?.lastFilterChangeAt ?? 0,
		view: (out) => {
			// The spring targets, so a pan or zoom settles when the input stops, not
			// when the animation does. Reused buffers: nothing allocates per tick.
			const x = chartContext.xScaleState;
			const y = chartContext.yScaleState;
			if (x instanceof LinearScaleState) {
				const domain = x.domain.targetBuffer;
				out[0] = domain[0];
				out[1] = domain[1];
			}
			if (y instanceof LinearScaleState) {
				const domain = y.domain.targetBuffer;
				out[2] = domain[0];
				out[3] = domain[1];
			}
			out[4] = layout.innerWidth;
			out[5] = layout.innerHeight;
		},
		settle: activateSources
	});

	/**
	 * Prepare the chart's selection sources. Runs on entering the cell, so band
	 * labels in the margin count, and again on entering the plot area, as before;
	 * activation skips tables that are still valid, so the second costs nothing.
	 */
	function activateSources() {
		// One batch: a newer hover drops the builds this one queued, while the
		// sources activated here (a brush, a Toggle, band labels) keep each other's.
		const activateAll = () => {
			for (const activate of chartContext.activators) activate();
		};
		if (queryEngine) queryEngine.batch(activateAll);
		else activateAll();
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
	class:palette-open={paletteOpen}
	bind:this={chartCellEl}
	bind:clientWidth={containerWidth}
	bind:clientHeight={containerHeight}
	onpointerenter={handleChartPointerEnter}
	onpointerleave={handleChartPointerLeave}
	onkeydown={handleKeyDown}
	tabindex="-1"
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
					<WebGPUCanvas {facetIndex} facetScale={facetingProps?.facetBandScale ?? null} />
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
				onlostpointercapture={() => hoverSettle.hold(false)}
				ondblclick={handleDoubleClick}
				onclick={handleClick}
				oncontextmenu={handleContextMenu}
			>
				<defs>
					<clipPath id={layout.clipPathId}>
						<rect
							x={-layout.config.clipPadding}
							y={0}
							width={layout.innerWidth + layout.config.clipPadding * 2}
							height={layout.innerHeight}
						/>
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

			<CommandPalette bind:open={paletteOpen} />
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

	.chart-cell.palette-open {
		contain: layout style;
		overflow: visible;
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

	/* Prevent host CSS (marimo, Jupyter) from adding rectangular outlines to SVG elements */
	.svg-foreground :global(*) {
		outline: none;
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
