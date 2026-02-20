<script>
	import { getContext, onMount } from 'svelte';
	import { clauseIntervals } from '@uwdata/mosaic-core';
	import { BrushState2D } from './brush-state.svelte.js';
	import BrushOverlay from './BrushOverlay.svelte';
	import {
		buildColumnRef,
		closeTo,
		isDragging,
		scaleBrushExtent2D,
		WHEEL_SENSITIVITY
	} from './brush-utils';

	let { bridge, xField, yField } = $props();

	const chart = getContext('chart');
	const brush = new BrushState2D();

	const resolvedXField = $derived(xField ?? chart.xLabel);
	const resolvedYField = $derived(yField ?? chart.yLabel);

	const xColumnRef = $derived(buildColumnRef(resolvedXField, chart.xScaleState));
	const yColumnRef = $derived(buildColumnRef(resolvedYField, chart.yScaleState));

	const source = `interval-2d-${chart.chartId}`;

	const { sel: selection, off: unregister } = bridge.createLocal('single', {
		source,
		augment: (clause) => ({
			kind: 'range',
			label: `${typeof resolvedXField === 'string' ? resolvedXField : resolvedXField?.toString()} × ${typeof resolvedYField === 'string' ? resolvedYField : resolvedYField?.toString()}`,
			xColumn: resolvedXField,
			yColumn: resolvedYField,
			xValues: clause?.value?.[0],
			yValues: clause?.value?.[1]
		}),
		onVisualClear: () => brush.clear()
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
	$effect(() => {
		const xScaleType = chart.xScaleState?.scaleType;
		const yScaleType = chart.yScaleState?.scaleType;

		let invalid = false;
		if (brush.active && xScaleType && !brush.x.validate(chart.xScale, xScaleType)) {
			invalid = true;
		}
		if (brush.active && yScaleType && !brush.y.validate(chart.yScale, yScaleType)) {
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
		return { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin };
	});

	// Emit Mosaic clause
	function emitClause() {
		if (!brush.active || !xColumnRef || !yColumnRef) return;

		const xMin = Math.min(brush.x.dataMin, brush.x.dataMax);
		const xMax = Math.max(brush.x.dataMin, brush.x.dataMax);
		const yMin = Math.min(brush.y.dataMin, brush.y.dataMax);
		const yMax = Math.max(brush.y.dataMin, brush.y.dataMax);

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

		const clause = clauseIntervals(
			[xColumnRef, yColumnRef],
			[
				[xMin, xMax],
				[yMin, yMax]
			],
			{
				source,
				clients: chart.markClients,
				scales: [
					{
						type: chart.xScaleState?.scaleType || 'linear',
						domain: chart.xScale.domain(),
						range: chart.xScale.range()
					},
					{
						type: chart.yScaleState?.scaleType || 'linear',
						domain: chart.yScale.domain(),
						range: chart.yScale.range()
					}
				]
			}
		);

		selection.update(clause);
	}

	// Pre-aggregation on pointer enter
	function handlePointerEnter() {
		if (!selection.activate || !chart.xScale || !chart.yScale || !xColumnRef || !yColumnRef) return;

		const xRange = brush.x.active
			? [Math.min(brush.x.dataMin, brush.x.dataMax), Math.max(brush.x.dataMin, brush.x.dataMax)]
			: [0, 1];
		const yRange = brush.y.active
			? [Math.min(brush.y.dataMin, brush.y.dataMax), Math.max(brush.y.dataMin, brush.y.dataMax)]
			: [0, 1];

		selection.activate(
			clauseIntervals([xColumnRef, yColumnRef], [xRange, yRange], {
				source,
				clients: chart.markClients,
				scales: [
					{
						type: chart.xScaleState?.scaleType || 'linear',
						domain: chart.xScale.domain(),
						range: chart.xScale.range()
					},
					{
						type: chart.yScaleState?.scaleType || 'linear',
						domain: chart.yScale.domain(),
						range: chart.yScale.range()
					}
				]
			})
		);
	}

	function handleWheel(event) {
		if (!event.shiftKey) return;

		event.preventDefault();
		event.stopPropagation();

		const scaleFactor = 1 + event.deltaY * WHEEL_SENSITIVITY;

		const xMin = Math.min(brush.x.dataMin, brush.x.dataMax);
		const xMax = Math.max(brush.x.dataMin, brush.x.dataMax);
		const yMin = Math.min(brush.y.dataMin, brush.y.dataMax);
		const yMax = Math.max(brush.y.dataMin, brush.y.dataMax);

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
		selection.update({
			predicate: null,
			source,
			clients: chart.markClients,
			value: null
		});
	}

	// --- Pointer Event Handlers (registered as chart context callbacks) ---

	function handlePointerDown(event, innerPoint) {
		if (brush.phase !== 'idle') return false;

		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;
		hasDragged = false;

		anchorX = innerPoint.x;
		anchorY = innerPoint.y;
		currentX = innerPoint.x;
		currentY = innerPoint.y;
		return true;
	}

	function handlePointerMove(event) {
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
				const anchorXData = corner.includes('e') ? brush.x.dataMin : brush.x.dataMax;
				const anchorYData = corner.includes('s') ? brush.y.dataMax : brush.y.dataMin;

				const currentXData = chart.xScale.invert(currentX);
				const currentYData = chart.yScale.invert(currentY);

				brush.x.setExtent(Math.min(anchorXData, currentXData), Math.max(anchorXData, currentXData));
				brush.y.setExtent(Math.min(anchorYData, currentYData), Math.max(anchorYData, currentYData));
			} else {
				const edge = brush.x.resizeEdge || brush.y.resizeEdge;
				if (edge === 'left' || edge === 'right') {
					const anchorXData = edge === 'left' ? brush.x.dataMax : brush.x.dataMin;
					const currentXData = chart.xScale.invert(currentX);
					brush.x.setExtent(
						Math.min(anchorXData, currentXData),
						Math.max(anchorXData, currentXData)
					);
				} else if (edge === 'top' || edge === 'bottom') {
					const anchorYData = edge === 'top' ? brush.y.dataMin : brush.y.dataMax;
					const currentYData = chart.yScale.invert(currentY);
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

	function handlePointerUp(event) {
		if (!isCapturing) return false;

		event.target.releasePointerCapture(event.pointerId);
		isCapturing = false;

		if (!hasDragged && brush.active && brush.phase === 'idle') {
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

	function handleMoveStart(event) {
		event.stopPropagation();
		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchorX = innerCoords.x;
		anchorY = innerCoords.y;
		currentX = innerCoords.x;
		currentY = innerCoords.y;
		brush.phase = 'moving';
	}

	function handleResizeStart(edge, event) {
		event.stopPropagation();
		event.target.setPointerCapture(event.pointerId);
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
		chart.onInteractorPointerEnter = handlePointerEnter;

		return () => {
			chart.onInteractorPointerDown = null;
			chart.onInteractorPointerMove = null;
			chart.onInteractorPointerUp = null;
			chart.onInteractorPointerEnter = null;
			unregister();
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
