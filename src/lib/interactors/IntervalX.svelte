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

	// Field to filter (default to chart's x axis)
	const resolvedField = $derived(field ?? chart.xLabel);

	// Register with FilterBridge to get a local Selection
	const { sel: selection, off: unregister } = bridge.createLocal('single', {
		source: `interval-x-${chart.chartId}`,
		augment: (clause) => ({
			kind: 'range',
			column: resolvedField,
			label: resolvedField,
			values: clause?.value ? [clause.value[0], clause.value[1]] : []
		}),
		onVisualClear: () => brush.clear() // Two-way sync
	});

	// Pointer state (reused to avoid GC)
	let anchorX = 0;
	let currentX = 0;
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
		const scaleType = chart.xScaleState?.scaleType;
		if (brush.active && scaleType && !brush.validate(chart.xScale, scaleType)) {
			clearBrush();
		}
	});

	// Derived screen coordinates
	const brushScreenX = $derived.by(() => {
		if (!brush.active) return null;
		const [min, max] = brush.screenExtent(chart.xScale);
		return { x: min, width: max - min };
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
				source: `interval-x-${chart.chartId}`,
				clients: chart.markClients, // Crossfilter exclusion
				scale: {
					type: chart.xScaleState?.scaleType || 'linear',
					domain: chart.xScale.domain(),
					range: chart.xScale.range()
				}
			}
		);

		selection.update(clause);
	}

	// Pre-aggregation on pointer enter
	function handlePointerEnter() {
		if (!selection.activate || !chart.xScale || !resolvedField) return;

		const range = brush.active
			? [Math.min(brush.dataMin, brush.dataMax), Math.max(brush.dataMin, brush.dataMax)]
			: [0, 1];

		selection.activate(
			clauseInterval(
				column(resolvedField),
				range,
				{
					source: `interval-x-${chart.chartId}`,
					clients: chart.markClients,
					scale: {
						type: chart.xScaleState?.scaleType || 'linear',
						domain: chart.xScale.domain(),
						range: chart.xScale.range()
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
		const xMin = Math.min(brush.dataMin, brush.dataMax);
		const xMax = Math.max(brush.dataMin, brush.dataMax);

		// Scale around center
		const [newMin, newMax] = scaleBrushExtent1D(xMin, xMax, scaleFactor);
		brush.setExtent(newMin, newMax);

		// Emit updated clause
		emitClause();
	}

	function clearBrush() {
		brush.clear();
		selection.update({
			predicate: null,
			source: `interval-x-${chart.chartId}`,
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

		anchorX = innerCoords.x;
		currentX = innerCoords.x;

		// Don't start creating yet - wait for pointermove to detect drag vs click
	}

	function handlePointerMove(event) {
		if (!isCapturing) return;

		// Reuse point object to reduce GC (toInnerCoordinates returns new object)
		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		currentX = innerCoords.x;

		// Detect drag vs click
		if (!hasDragged && isDragging(anchorX, currentX)) {
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
			brush.setFromScreen(anchorX, currentX, chart.xScale);
		} else if (brush.phase === 'moving') {
			const delta = currentX - anchorX;
			brush.shiftByScreen(delta, chart.xScale);
			anchorX = currentX;
		} else if (brush.phase === 'resizing') {
			// Use anchor point approach - opposite edge stays fixed
			const anchorData = brush.resizeEdge === 'left' ? brush.dataMax : brush.dataMin;
			const currentData = chart.xScale.invert(currentX);
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
		anchorX = innerCoords.x;
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
		anchorX = innerCoords.x;
		brush.phase = 'resizing';
		brush.resizeEdge = edge === 'left' ? 'left' : 'right';
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
	class="interval-x-interactor"
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
	{#if brush.active && brushScreenX}
		<BrushOverlay
			x={brushScreenX.x}
			y={0}
			width={brushScreenX.width}
			height={chart.innerHeight}
			orientation="x"
			onMoveStart={handleMoveStart}
			onResizeStart={handleResizeStart}
			onWheel={handleWheel}
		/>
	{/if}
</g>
