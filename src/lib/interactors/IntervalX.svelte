<script>
	import { getContext, onMount } from 'svelte';
	import { clauseInterval } from '@uwdata/mosaic-core';
	import { column, sql } from '@uwdata/mosaic-sql';
	import { BrushState1D } from './brush-state.svelte.js';
	import BrushOverlay from './BrushOverlay.svelte';

	let { bridge, field, dimUnselected = true } = $props();

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
		if (!selection.activate) return;

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

	function clearBrush() {
		brush.clear();
		selection.update({
			predicate: sql`TRUE`,
			source: `interval-x-${chart.chartId}`,
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

		anchorX = innerPoint.x;
		currentX = innerPoint.x;
		brush.phase = 'creating';
		brush.setFromScreen(anchorX, currentX, chart.xScale);
	}

	function handlePointerMove(event) {
		if (!isCapturing) return;

		const point = { x: event.offsetX, y: event.offsetY };
		const innerPoint = chart.toInnerCoordinates(point);
		currentX = innerPoint.x;

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
		anchorX = innerPoint.x;
		brush.phase = 'moving';
	}

	function handleResizeStart(edge, event) {
		event.stopPropagation();
		event.target.setPointerCapture(event.pointerId);
		isCapturing = true;

		const point = { x: event.offsetX, y: event.offsetY };
		const innerPoint = chart.toInnerCoordinates(point);
		anchorX = innerPoint.x;
		brush.phase = 'resizing';
		brush.resizeEdge = edge === 'left' ? 'left' : 'right';
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
	class="interval-x-interactor"
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
	{#if brush.active && brushScreenX}
		<BrushOverlay
			x={brushScreenX.x}
			y={0}
			width={brushScreenX.width}
			height={chart.innerHeight}
			orientation="x"
			{dimUnselected}
			onMoveStart={handleMoveStart}
			onResizeStart={handleResizeStart}
		/>
	{/if}
</g>
