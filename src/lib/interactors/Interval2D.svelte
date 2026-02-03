<script>
	import { getContext } from 'svelte';
	import { clauseIntervals } from '@uwdata/mosaic-core';
	import { column, sql } from '@uwdata/mosaic-sql';
	import { BrushState2D } from './brush-state.svelte.js';
	import BrushOverlay from './BrushOverlay.svelte';

	let { bridge, xField, yField, dimUnselected = true } = $props();

	const chart = getContext('chart');
	const brush = new BrushState2D();

	const resolvedXField = $derived(xField ?? chart.xLabel);
	const resolvedYField = $derived(yField ?? chart.yLabel);

	const { sel: selection, off: unregister } = bridge.createLocal('single', {
		source: `interval-2d-${chart.chartId}`,
		augment: (clause) => ({
			kind: 'range',
			label: `${resolvedXField} × ${resolvedYField}`,
			// Store both X and Y ranges in metadata
			xColumn: resolvedXField,
			yColumn: resolvedYField,
			xValues: clause?.value?.[0],
			yValues: clause?.value?.[1]
		}),
		onVisualClear: () => brush.clear() // Two-way sync
	});

	// Pointer state (reused to avoid GC)
	let anchorX = 0;
	let anchorY = 0;
	let currentX = 0;
	let currentY = 0;
	let isCapturing = false;

	// Deduplication (skip redundant updates)
	let lastEmittedMinX = null;
	let lastEmittedMaxX = null;
	let lastEmittedMinY = null;
	let lastEmittedMaxY = null;
	const EPS = 1e-12;

	function closeTo(a, b) {
		return a === b || (a != null && b != null && Math.abs(a - b) < EPS);
	}

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
		if (!brush.active) return;

		// Normalize ranges (ensure min < max) to handle inverted brushes from corner resize
		const xMin = Math.min(brush.x.dataMin, brush.x.dataMax);
		const xMax = Math.max(brush.x.dataMin, brush.x.dataMax);
		const yMin = Math.min(brush.y.dataMin, brush.y.dataMax);
		const yMax = Math.max(brush.y.dataMin, brush.y.dataMax);

		// Deduplication: skip if values haven't changed significantly
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
			[column(resolvedXField), column(resolvedYField)],
			[
				[xMin, xMax],
				[yMin, yMax]
			],
			{
				source: `interval-2d-${chart.chartId}`,
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
		if (!selection.activate) return;

		// Normalize ranges for activate call too
		const xRange = brush.x.active
			? [Math.min(brush.x.dataMin, brush.x.dataMax), Math.max(brush.x.dataMin, brush.x.dataMax)]
			: [0, 1];
		const yRange = brush.y.active
			? [Math.min(brush.y.dataMin, brush.y.dataMax), Math.max(brush.y.dataMin, brush.y.dataMax)]
			: [0, 1];

		selection.activate(
			clauseIntervals(
				[column(resolvedXField), column(resolvedYField)],
				[xRange, yRange],
				{
					source: `interval-2d-${chart.chartId}`,
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
			)
		);
	}

	function clearBrush() {
		brush.clear();
		selection.update({
			predicate: sql`TRUE`,
			source: `interval-2d-${chart.chartId}`,
			clients: chart.markClients
		});
	}

	// --- Pointer Event Handlers ---

	function handleBackgroundPointerDown(event) {
		if (brush.phase !== 'idle') return;

		event.stopPropagation();
		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;

		const point = { x: event.offsetX, y: event.offsetY };
		const innerPoint = chart.toInnerCoordinates(point);

		anchorX = innerPoint.x;
		anchorY = innerPoint.y;
		currentX = innerPoint.x;
		currentY = innerPoint.y;
		brush.phase = 'creating';
		brush.x.setFromScreen(anchorX, currentX, chart.xScale);
		brush.y.setFromScreen(anchorY, currentY, chart.yScale);
	}

	function handlePointerMove(event) {
		if (!isCapturing) return;

		const point = { x: event.offsetX, y: event.offsetY };
		const innerPoint = chart.toInnerCoordinates(point);
		currentX = innerPoint.x;
		currentY = innerPoint.y;

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
			// Handle corner resizing - use anchor point approach
			const corner = brush.resizeCorner;
			if (corner) {
				// Store the opposite corner as anchor (stays fixed)
				const anchorXData = corner.includes('e') ? brush.x.dataMin : brush.x.dataMax;
				const anchorYData = corner.includes('s') ? brush.y.dataMax : brush.y.dataMin;

				// Set the moving corner to current position
				const currentXData = chart.xScale.invert(currentX);
				const currentYData = chart.yScale.invert(currentY);

				// Update min/max based on which is smaller (use setExtent to batch updates)
				brush.x.setExtent(Math.min(anchorXData, currentXData), Math.max(anchorXData, currentXData));
				brush.y.setExtent(Math.min(anchorYData, currentYData), Math.max(anchorYData, currentYData));
			} else {
				// Handle edge resizing
				const edge = brush.x.resizeEdge || brush.y.resizeEdge;
				if (edge === 'left' || edge === 'right') {
					const anchorXData = edge === 'left' ? brush.x.dataMax : brush.x.dataMin;
					const currentXData = chart.xScale.invert(currentX);
					brush.x.setExtent(Math.min(anchorXData, currentXData), Math.max(anchorXData, currentXData));
				} else if (edge === 'top' || edge === 'bottom') {
					// Anchor to OPPOSITE edge: top drags → anchor bottom, bottom drags → anchor top
					const anchorYData = edge === 'top' ? brush.y.dataMin : brush.y.dataMax;
					const currentYData = chart.yScale.invert(currentY);
					brush.y.setExtent(Math.min(anchorYData, currentYData), Math.max(anchorYData, currentYData));
				}
			}
		}

		// Continuous updates during drag
		emitClause();
	}

	function handlePointerUp(event) {
		if (!isCapturing) return;

		event.target.releasePointerCapture(event.pointerId);
		isCapturing = false;

		if (brush.phase !== 'idle') {
			emitClause();
			brush.phase = 'idle';
			brush.resizeCorner = null;
			brush.x.resizeEdge = null;
			brush.y.resizeEdge = null;
		}
	}

	function handleMoveStart(event) {
		event.stopPropagation();
		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;

		const point = { x: event.offsetX, y: event.offsetY };
		const innerPoint = chart.toInnerCoordinates(point);
		anchorX = innerPoint.x;
		anchorY = innerPoint.y;
		currentX = innerPoint.x;
		currentY = innerPoint.y;
		brush.phase = 'moving';
	}

	function handleResizeStart(edge, event) {
		event.stopPropagation();
		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;

		const point = { x: event.offsetX, y: event.offsetY };
		const innerPoint = chart.toInnerCoordinates(point);
		anchorX = innerPoint.x;
		anchorY = innerPoint.y;
		currentX = innerPoint.x;
		currentY = innerPoint.y;
		brush.phase = 'resizing';

		// Check if it's a corner or edge
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

	function handleDoubleClick(event) {
		event.stopPropagation();
		clearBrush();
	}

	// Cleanup
	$effect(() => {
		return () => unregister();
	});
</script>

<g
	class="interval-2d-interactor"
	onpointerenter={handlePointerEnter}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	ondblclick={handleDoubleClick}
>
	<!-- Full-area background for creating new brushes -->
	<rect
		class="brush-background"
		x={0}
		y={0}
		width={chart.innerWidth}
		height={chart.innerHeight}
		fill="transparent"
		style="cursor: crosshair;"
		onpointerdown={handleBackgroundPointerDown}
	/>

	<!-- Brush overlay when active -->
	{#if brush.active && brushScreen}
		<BrushOverlay
			x={brushScreen.x}
			y={brushScreen.y}
			width={brushScreen.width}
			height={brushScreen.height}
			orientation="2d"
			{dimUnselected}
			onMoveStart={handleMoveStart}
			onResizeStart={handleResizeStart}
		/>
	{/if}
</g>
