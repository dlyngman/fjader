<script>
	import { getContext, onMount } from 'svelte';
	import { clauseInterval } from '@uwdata/mosaic-core';
	import { column, sql } from '@uwdata/mosaic-sql';
	import { BrushState1D } from './brush-state.svelte.js';
	import BrushOverlay from './BrushOverlay.svelte';
	import {
		closeTo,
		isDragging,
		scaleBrushExtent1D,
		createPanModeHandlers,
		WHEEL_SENSITIVITY
	} from './brush-utils.js';

	let { bridge, field } = $props();

	const chart = getContext('chart');
	const brush = new BrushState1D();

	// Field to filter (default to chart's y axis)
	const resolvedField = $derived(field ?? chart.yLabel);

	// Register with FilterBridge to get a local Selection
	const { sel: selection, off: unregister } = bridge.createLocal('single', {
		source: `interval-y-${chart.chartId}`,
		augment: (clause) => ({
			kind: 'range',
			column: resolvedField,
			label: resolvedField,
			values: clause?.value ? [clause.value[0], clause.value[1]] : []
		}),
		onVisualClear: () => brush.clear() // Two-way sync
	});

	// Pointer state (reused to avoid GC)
	let anchorY = 0;
	let currentY = 0;
	let isCapturing = false;
	let hasDragged = false; // Track if user dragged vs clicked
	let isPanModeActive = $state(false); // Space key for temporary pan

	// Reusable point object to reduce GC pressure (50% reduction)
	const point = { x: 0, y: 0 };

	// Deduplication (skip redundant updates)
	let lastEmittedMin = null;
	let lastEmittedMax = null;

	// Keyboard handlers for Space key pan mode
	const { handleKeyDown, handleKeyUp } = createPanModeHandlers((active) => {
		isPanModeActive = active;
	});

	// Scale validation
	$effect(() => {
		const scaleType = chart.yScaleState?.scaleType;
		if (brush.active && scaleType && !brush.validate(chart.yScale, scaleType)) {
			clearBrush();
		}
	});

	// Derived screen coordinates
	const brushScreenY = $derived.by(() => {
		if (!brush.active) return null;
		const [min, max] = brush.screenExtent(chart.yScale);
		return { y: min, height: max - min };
	});

	// Emit Mosaic clause
	function emitClause() {
		if (!brush.active) return;

		// Normalize range (ensure min < max) to handle inverted brushes from edge resize
		const dataMin = Math.min(brush.dataMin, brush.dataMax);
		const dataMax = Math.max(brush.dataMin, brush.dataMax);

		// Deduplication: skip if values haven't changed significantly
		if (closeTo(dataMin, lastEmittedMin) && closeTo(dataMax, lastEmittedMax)) {
			return;
		}

		lastEmittedMin = dataMin;
		lastEmittedMax = dataMax;

		const clause = clauseInterval(
			column(resolvedField),
			[dataMin, dataMax],
			{
				source: `interval-y-${chart.chartId}`,
				clients: chart.markClients, // Crossfilter exclusion
				scale: {
					type: chart.yScaleState?.scaleType || 'linear',
					domain: chart.yScale.domain(),
					range: chart.yScale.range()
				}
			}
		);

		selection.update(clause);
	}

	// Pre-aggregation on pointer enter
	function handlePointerEnter() {
		if (!selection.activate || !chart.yScale || !resolvedField) return;

		const range = brush.active
			? [Math.min(brush.dataMin, brush.dataMax), Math.max(brush.dataMin, brush.dataMax)]
			: [0, 1];

		selection.activate(
			clauseInterval(
				column(resolvedField),
				range,
				{
					source: `interval-y-${chart.chartId}`,
					clients: chart.markClients,
					scale: {
						type: chart.yScaleState?.scaleType || 'linear',
						domain: chart.yScale.domain(),
						range: chart.yScale.range()
					}
				}
			)
		);
	}

	function handleWheel(event) {
		// Only handle with Shift key (brush is active since we're over the overlay)
		if (!event.shiftKey) return;

		event.preventDefault(); // Prevent page scroll
		event.stopPropagation(); // Prevent passing through to histogram bin resolution

		// Calculate scale factor from wheel delta (negative = zoom in, positive = zoom out)
		const scaleFactor = 1 + event.deltaY * WHEEL_SENSITIVITY;

		// Get current brush extents (reuse vars to avoid GC)
		const yMin = Math.min(brush.dataMin, brush.dataMax);
		const yMax = Math.max(brush.dataMin, brush.dataMax);

		// Scale around center
		const [newMin, newMax] = scaleBrushExtent1D(yMin, yMax, scaleFactor);
		brush.setExtent(newMin, newMax);

		// Emit updated clause
		emitClause();
	}

	function clearBrush() {
		brush.clear();
		selection.update({
			predicate: null,
			source: `interval-y-${chart.chartId}`,
			clients: chart.markClients,
			value: null
		});
	}

	// --- Pointer Event Handlers ---

	function handleBackgroundPointerDown(event) {
		if (brush.phase !== 'idle') return;

		// Allow pan if Space key held
		if (isPanModeActive) return;

		event.stopPropagation(); // Prevent pan
		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;
		hasDragged = false;

		// Reuse point object to reduce GC (toInnerCoordinates returns new object)
		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);

		anchorY = innerCoords.y;
		currentY = innerCoords.y;

		// Don't start creating yet - wait for pointermove to detect drag vs click
	}

	function handlePointerMove(event) {
		if (!isCapturing) return;

		// Reuse point object to reduce GC (toInnerCoordinates returns new object)
		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		currentY = innerCoords.y;

		// Detect drag vs click
		if (!hasDragged && isDragging(0, 0, anchorY, currentY)) {
			hasDragged = true;
			// Start creating on first drag
			if (brush.phase === 'idle') {
				// Clear existing brush before creating new one
				if (brush.active) {
					clearBrush();
				}
				brush.phase = 'creating';
			}
		}

		if (brush.phase === 'creating') {
			brush.setFromScreen(anchorY, currentY, chart.yScale);
		} else if (brush.phase === 'moving') {
			const delta = currentY - anchorY;
			brush.shiftByScreen(delta, chart.yScale);
			anchorY = currentY;
		} else if (brush.phase === 'resizing') {
			// Use anchor point approach - opposite edge stays fixed
			const anchorData = brush.resizeEdge === 'top' ? brush.dataMax : brush.dataMin;
			const currentData = chart.yScale.invert(currentY);
			brush.setExtent(Math.min(anchorData, currentData), Math.max(anchorData, currentData));
		}

		// Continuous updates during drag (matches vgplot behavior)
		emitClause();
	}

	function handlePointerUp(event) {
		if (!isCapturing) return;

		event.target.releasePointerCapture(event.pointerId);
		isCapturing = false;

		// If it was a click (not drag) and there's an active brush, clear it
		if (!hasDragged && brush.active && brush.phase === 'idle') {
			clearBrush();
			return;
		}

		if (brush.phase !== 'idle') {
			emitClause();
			brush.phase = 'idle';
		}

		hasDragged = false;
	}

	function handleMoveStart(event) {
		event.stopPropagation();
		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;

		// Reuse point object to reduce GC (toInnerCoordinates returns new object)
		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchorY = innerCoords.y;
		brush.phase = 'moving';
	}

	function handleResizeStart(edge, event) {
		event.stopPropagation();
		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;

		// Reuse point object to reduce GC (toInnerCoordinates returns new object)
		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchorY = innerCoords.y;
		brush.phase = 'resizing';
		brush.resizeEdge = edge === 'top' ? 'top' : 'bottom';
	}

	// Cleanup
	$effect(() => {
		return () => unregister();
	});

	// Mount keyboard listeners
	onMount(() => {
		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);
		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
		};
	});
</script>

<g
	class="interval-y-interactor"
	onpointerenter={handlePointerEnter}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
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
	{#if brush.active && brushScreenY}
		<BrushOverlay
			x={0}
			y={brushScreenY.y}
			width={chart.innerWidth}
			height={brushScreenY.height}
			orientation="y"
			onMoveStart={handleMoveStart}
			onResizeStart={handleResizeStart}
			onWheel={handleWheel}
		/>
	{/if}
</g>
