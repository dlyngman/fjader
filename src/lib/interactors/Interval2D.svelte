<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { and, isBetween } from '@uwdata/mosaic-sql';
	import { BrushState2D } from './brush-state.svelte';
	import BrushOverlay from './BrushOverlay.svelte';
	import {
		buildColumnRef,
		closeTo,
		isDragging,
		scaleBrushExtent2D,
		WHEEL_SENSITIVITY
	} from './brush-utils';
	import type { ChartContext, FieldRef, Point } from '$lib/types';
	import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { SourceHandle } from '$lib/query-engine/FilterGroup.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	interface Props {
		/** Filter group name — selects which FilterGroup this brush writes to. */
		selection?: string;
		xField?: FieldRef;
		yField?: FieldRef;
	}

	let { selection, xField, yField }: Props = $props();

	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const filterGroup = filterGroups.get(selection);

	const chart = getContext<ChartContext>('chart');
	const brush = new BrushState2D();

	const resolvedXField = $derived(xField ?? chart.xColumnName ?? chart.xLabel);
	const resolvedYField = $derived(yField ?? chart.yColumnName ?? chart.yLabel);

	const xColumnRef = $derived(
		buildColumnRef(resolvedXField, chart.xScaleState as { t0?: Date } | null)
	);
	const yColumnRef = $derived(
		buildColumnRef(resolvedYField, chart.yScaleState as { t0?: Date } | null)
	);

	const source = `interval-2d-${chart.chartId}`;

	/** The data extent of a continuous axis, for the preagg size guard. */
	const extentOf = (state: unknown) =>
		state instanceof LinearScaleState ? state.effectiveExtent : undefined;

	/** Where an axis's domain is heading (the spring target), so a table built
	 *  while it still moves fits the view it settles on. */
	const targetOf = (state: unknown, scale: { domain(): unknown }) =>
		state instanceof LinearScaleState ? state.domain.target : (scale.domain() as [number, number]);

	const brushHandle: SourceHandle = filterGroup.register(source, {
		excludeMarkIds: () => new Set(chart.config.entries.keys()),
		activeDims: () => {
			if (!xColumnRef || !yColumnRef) return [];
			return [
				{
					kind: 'bin',
					columnRef: xColumnRef,
					domain: targetOf(chart.xScaleState, chart.xScale),
					pixelExtent: chart.innerWidth,
					extent: extentOf(chart.xScaleState)
				},
				{
					kind: 'bin',
					columnRef: yColumnRef,
					domain: targetOf(chart.yScaleState, chart.yScale),
					pixelExtent: chart.innerHeight,
					extent: extentOf(chart.yScaleState)
				}
			];
		},
		// Read on every query: the scale states' target buffers are reused, so this
		// allocates nothing. The targets, like activeDims, not the animated domains.
		view: (out) => {
			const x = chart.xScaleState;
			const y = chart.yScaleState;
			if (!(x instanceof LinearScaleState) || !(y instanceof LinearScaleState)) return;
			const xDomain = x.domain.targetBuffer;
			out[0] = xDomain[0];
			out[1] = xDomain[1];
			out[2] = chart.innerWidth;
			const yDomain = y.domain.targetBuffer;
			out[3] = yDomain[0];
			out[4] = yDomain[1];
			out[5] = chart.innerHeight;
		},
		augment: (value) => ({
			kind: 'range',
			label: `${typeof resolvedXField === 'string' ? resolvedXField : resolvedXField?.toString()} × ${typeof resolvedYField === 'string' ? resolvedYField : resolvedYField?.toString()}`,
			xColumn: resolvedXField,
			yColumn: resolvedYField,
			xValues: (value as unknown[][])?.[0],
			yValues: (value as unknown[][])?.[1]
		})
	});

	// Pointer state (reused to avoid GC)
	let anchorX = 0;
	let anchorY = 0;
	let currentX = 0;
	let currentY = 0;
	let isCapturing = false;
	let hasDragged = false;

	// Reusable point object to reduce GC pressure
	const point = { x: 0, y: 0 };

	// Deduplication (skip redundant updates)
	let lastEmittedMinX = null;
	let lastEmittedMaxX = null;
	let lastEmittedMinY = null;
	let lastEmittedMaxY = null;

	// Scale validation for both dimensions
	// Always validate as 'linear': DivePlot time scales use float offsets, not Dates.
	$effect(() => {
		let invalid = false;
		if (
			brush.active &&
			chart.xScale &&
			!brush.x.validate(chart.xScale as { domain: () => number[] }, 'linear')
		) {
			invalid = true;
		}
		if (
			brush.active &&
			chart.yScale &&
			!brush.y.validate(chart.yScale as { domain: () => number[] }, 'linear')
		) {
			invalid = true;
		}
		if (invalid) {
			clearBrush();
		}
	});

	// Derived screen coordinates
	const brushScreen = $derived.by(() => {
		if (!brush.active) return null;
		const [xMin, xMax] = brush.x.screenExtent(chart.xScale);
		const [yMin, yMax] = brush.y.screenExtent(chart.yScale);
		// Clamp to chart bounds for rendering — data extent is preserved
		const cx0 = Math.max(0, xMin);
		const cx1 = Math.min(chart.innerWidth, xMax);
		const cy0 = Math.max(0, yMin);
		const cy1 = Math.min(chart.innerHeight, yMax);
		if (cx1 <= cx0 || cy1 <= cy0) return null;
		return { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 };
	});

	function emitClause() {
		if (!brush.active || !xColumnRef || !yColumnRef) return;

		const xMin = Math.min(brush.x.dataMin as number, brush.x.dataMax as number);
		const xMax = Math.max(brush.x.dataMin as number, brush.x.dataMax as number);
		const yMin = Math.min(brush.y.dataMin as number, brush.y.dataMax as number);
		const yMax = Math.max(brush.y.dataMin as number, brush.y.dataMax as number);

		if (
			closeTo(xMin, lastEmittedMinX) &&
			closeTo(xMax, lastEmittedMaxX) &&
			closeTo(yMin, lastEmittedMinY) &&
			closeTo(yMax, lastEmittedMaxY)
		) {
			return;
		}

		lastEmittedMinX = xMin;
		lastEmittedMaxX = xMax;
		lastEmittedMinY = yMin;
		lastEmittedMaxY = yMax;

		const predicate = and([
			isBetween(xColumnRef, [xMin, xMax]),
			isBetween(yColumnRef, [yMin, yMax])
		]);
		brushHandle.update(predicate, [
			[xMin, xMax],
			[yMin, yMax]
		]);
	}

	function handleWheel(event: WheelEvent) {
		if (!event.shiftKey) return;

		event.preventDefault();
		event.stopPropagation();

		const scaleFactor = 1 + event.deltaY * WHEEL_SENSITIVITY;

		const xMin = Math.min(brush.x.dataMin as number, brush.x.dataMax as number);
		const xMax = Math.max(brush.x.dataMin as number, brush.x.dataMax as number);
		const yMin = Math.min(brush.y.dataMin as number, brush.y.dataMax as number);
		const yMax = Math.max(brush.y.dataMin as number, brush.y.dataMax as number);

		const {
			x: [newXMin, newXMax],
			y: [newYMin, newYMax]
		} = scaleBrushExtent2D(xMin, xMax, yMin, yMax, scaleFactor);

		brush.x.setExtent(newXMin, newXMax);
		brush.y.setExtent(newYMin, newYMax);

		emitClause();
	}

	function clearBrush() {
		brush.clear();
		lastEmittedMinX = null;
		lastEmittedMaxX = null;
		lastEmittedMinY = null;
		lastEmittedMaxY = null;
		brushHandle.clear();
	}

	// --- Pointer Event Handlers (registered as chart context callbacks) ---

	function handlePointerDown(event: PointerEvent, innerPoint: Point) {
		if (brush.phase !== 'idle') return false;

		(event.target as Element).setPointerCapture(event.pointerId);
		isCapturing = true;
		hasDragged = false;

		anchorX = innerPoint.x;
		anchorY = innerPoint.y;
		currentX = innerPoint.x;
		currentY = innerPoint.y;
		return true;
	}

	function handlePointerMove(event: PointerEvent) {
		if (!isCapturing) return false;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		currentX = innerCoords.x;
		currentY = innerCoords.y;

		if (!hasDragged && isDragging(anchorX, currentX, anchorY, currentY)) {
			hasDragged = true;
			if (brush.phase === 'idle') {
				if (brush.active) {
					clearBrush();
				}
				brush.phase = 'creating';
			}
		}

		if (brush.phase === 'creating') {
			brush.x.setFromScreen(anchorX, currentX, chart.xScale);
			brush.y.setFromScreen(anchorY, currentY, chart.yScale);
		} else if (brush.phase === 'moving') {
			const deltaX = currentX - anchorX;
			const deltaY = currentY - anchorY;
			brush.x.shiftByScreen(deltaX, chart.xScale);
			brush.y.shiftByScreen(deltaY, chart.yScale);
			anchorX = currentX;
			anchorY = currentY;
		} else if (brush.phase === 'resizing') {
			const corner = brush.resizeCorner;
			if (corner) {
				const anchorXData = (corner.includes('e') ? brush.x.dataMin : brush.x.dataMax) as number;
				const anchorYData = (corner.includes('s') ? brush.y.dataMax : brush.y.dataMin) as number;

				const currentXData = chart.xScale.invert!(currentX);
				const currentYData = chart.yScale.invert!(currentY);

				brush.x.setExtent(Math.min(anchorXData, currentXData), Math.max(anchorXData, currentXData));
				brush.y.setExtent(Math.min(anchorYData, currentYData), Math.max(anchorYData, currentYData));
			} else {
				const edge = brush.x.resizeEdge || brush.y.resizeEdge;
				if (edge === 'left' || edge === 'right') {
					const anchorXData = (edge === 'left' ? brush.x.dataMax : brush.x.dataMin) as number;
					const currentXData = chart.xScale.invert!(currentX);
					brush.x.setExtent(
						Math.min(anchorXData, currentXData),
						Math.max(anchorXData, currentXData)
					);
				} else if (edge === 'top' || edge === 'bottom') {
					const anchorYData = (edge === 'top' ? brush.y.dataMin : brush.y.dataMax) as number;
					const currentYData = chart.yScale.invert!(currentY);
					brush.y.setExtent(
						Math.min(anchorYData, currentYData),
						Math.max(anchorYData, currentYData)
					);
				}
			}
		}

		emitClause();
		return true;
	}

	function handlePointerUp(event: PointerEvent) {
		if (!isCapturing) return false;

		(event.target as Element).releasePointerCapture(event.pointerId);
		isCapturing = false;

		if (!hasDragged && brush.active && (brush.phase === 'idle' || brush.phase === 'moving')) {
			clearBrush();
			return true;
		}

		if (brush.phase !== 'idle') {
			emitClause();
			brush.phase = 'idle';
			brush.resizeCorner = null;
			brush.x.resizeEdge = null;
			brush.y.resizeEdge = null;
		}

		hasDragged = false;
		return true;
	}

	function handleMoveStart(event: PointerEvent) {
		event.stopPropagation();
		(event.target as Element).setPointerCapture(event.pointerId);
		isCapturing = true;
		hasDragged = false;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchorX = innerCoords.x;
		anchorY = innerCoords.y;
		currentX = innerCoords.x;
		currentY = innerCoords.y;
		brush.phase = 'moving';
	}

	function handleResizeStart(
		edge: 'left' | 'right' | 'top' | 'bottom' | 'nw' | 'ne' | 'sw' | 'se',
		event: PointerEvent
	) {
		event.stopPropagation();
		(event.target as HTMLElement).setPointerCapture(event.pointerId);
		isCapturing = true;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchorX = innerCoords.x;
		anchorY = innerCoords.y;
		currentX = innerCoords.x;
		currentY = innerCoords.y;
		brush.phase = 'resizing';

		if (edge === 'nw' || edge === 'ne' || edge === 'sw' || edge === 'se') {
			brush.resizeCorner = edge;
			brush.x.resizeEdge = null;
			brush.y.resizeEdge = null;
		} else {
			brush.resizeCorner = null;
			if (edge === 'left' || edge === 'right') {
				brush.x.resizeEdge = edge;
				brush.y.resizeEdge = null;
			} else {
				brush.x.resizeEdge = null;
				brush.y.resizeEdge = edge;
			}
		}
	}

	// Register callbacks
	onMount(() => {
		chart.onInteractorPointerDown = handlePointerDown;
		chart.onInteractorPointerMove = handlePointerMove;
		chart.onInteractorPointerUp = handlePointerUp;
		chart.activators.add(brushHandle.activate);

		return () => {
			chart.onInteractorPointerDown = null;
			chart.onInteractorPointerMove = null;
			chart.onInteractorPointerUp = null;
			chart.activators.delete(brushHandle.activate);
			brushHandle.destroy();
		};
	});
</script>

{#if brush.active && brushScreen}
	<BrushOverlay
		x={brushScreen.x}
		y={brushScreen.y}
		width={brushScreen.width}
		height={brushScreen.height}
		orientation="2d"
		onMoveStart={handleMoveStart}
		onResizeStart={handleResizeStart}
		onWheel={handleWheel}
	/>
{/if}
