<script>
	import { getContext, onMount } from 'svelte';
	import { clauseInterval } from '@uwdata/mosaic-core';
	import { column, sql } from '@uwdata/mosaic-sql';
	import { BrushState1D } from './brush-state.svelte.js';
	import BrushOverlay from './BrushOverlay.svelte';

	let { bridge, field, dimUnselected = true } = $props();

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
	let isPanModeActive = $state(false); // Space key for temporary pan

	// Deduplication (skip redundant updates)
	let lastEmittedMin = null;
	let lastEmittedMax = null;
	const EPS = 1e-12;

	function closeTo(a, b) {
		return a === b || (a != null && b != null && Math.abs(a - b) < EPS);
	}

	// Keyboard handlers for Space key
	function handleKeyDown(event) {
		if (event.code === 'Space' && !isPanModeActive) {
			isPanModeActive = true;
		}
	}

	function handleKeyUp(event) {
		if (event.code === 'Space') {
			isPanModeActive = false;
		}
	}

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
		if (!selection.activate) return;

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

	function clearBrush() {
		brush.clear();
		selection.update({
			predicate: sql`TRUE`,
			source: `interval-y-${chart.chartId}`,
			clients: chart.markClients
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

		const point = { x: event.offsetX, y: event.offsetY };
		const innerPoint = chart.toInnerCoordinates(point);

		anchorY = innerPoint.y;
		currentY = innerPoint.y;
		brush.phase = 'creating';
		brush.setFromScreen(anchorY, currentY, chart.yScale);
	}

	function handlePointerMove(event) {
		if (!isCapturing) return;

		const point = { x: event.offsetX, y: event.offsetY };
		const innerPoint = chart.toInnerCoordinates(point);
		currentY = innerPoint.y;

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

		if (brush.phase !== 'idle') {
			emitClause();
			brush.phase = 'idle';
		}
	}

	function handleMoveStart(event) {
		event.stopPropagation();
		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;

		const point = { x: event.offsetX, y: event.offsetY };
		const innerPoint = chart.toInnerCoordinates(point);
		anchorY = innerPoint.y;
		brush.phase = 'moving';
	}

	function handleResizeStart(edge, event) {
		event.stopPropagation();
		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;

		const point = { x: event.offsetX, y: event.offsetY };
		const innerPoint = chart.toInnerCoordinates(point);
		anchorY = innerPoint.y;
		brush.phase = 'resizing';
		brush.resizeEdge = edge === 'top' ? 'top' : 'bottom';
	}

	function handleDoubleClick(event) {
		event.stopPropagation();
		clearBrush();
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
	{#if brush.active && brushScreenY}
		<BrushOverlay
			x={0}
			y={brushScreenY.y}
			width={chart.innerWidth}
			height={brushScreenY.height}
			orientation="y"
			{dimUnselected}
			onMoveStart={handleMoveStart}
			onResizeStart={handleResizeStart}
		/>
	{/if}
</g>
