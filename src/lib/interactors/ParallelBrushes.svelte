<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { isBetween, column } from '@uwdata/mosaic-sql';
	import { SvelteMap } from 'svelte/reactivity';
	import BrushOverlay from './BrushOverlay.svelte';
	import ParallelAxisSource, { type ParallelAxis } from './ParallelAxisSource.svelte';
	import { closeTo, isDragging, createPanModeHandlers } from './brush-utils';
	import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { ChartContext, Point } from '$lib/types';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	type InvertibleScale = {
		(v: unknown): number;
		invert(v: number): number;
		domain(): number[];
		range(): number[];
	};

	interface Props {
		/** Filter group name — selects which FilterGroup these brushes write to. */
		selection?: string;
		/** When true, the parallel chart excludes itself from its own brush filters
		 *  (standard crossfilter behavior). When false (default), brushes self-filter
		 *  the chart — typical for parallel coordinates. */
		cross?: boolean;
	}

	let { selection, cross = false }: Props = $props();

	const chart = getContext<ChartContext>('chart');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const filterGroup = filterGroups.get(selection);

	const ps = $derived(chart.parallelScales);

	/**
	 * Each axis's state (source, brush, last emitted extent), by column, created
	 * and dropped by its ParallelAxisSource child. By column, not by position:
	 * removing a column renumbers the axes, and a brush must stay on its own.
	 */
	const axes = new SvelteMap<string, ParallelAxis>();

	/**
	 * The axis whose brush strip the pointer is in, by column, or null between
	 * strips. Only this axis's source is activated: one source per axis means
	 * one set of preagg tables per axis, and building every axis's on chart
	 * hover would be axes × marks builds, most for axes never brushed.
	 */
	let hoveredAxis: string | null = null;

	/** Make `col` the hovered axis; activate its source when it changes. A batch
	 *  of its own, so moving to another axis drops the previous one's queued builds. */
	function hoverAxis(col: string | null) {
		if (col === hoveredAxis) return;
		hoveredAxis = col;
		if (col) axes.get(col)?.handle.activate();
	}

	/** The chart's activator (hover, settling): the hovered axis, if any. */
	function activateHoveredAxis() {
		if (hoveredAxis) axes.get(hoveredAxis)?.handle.activate();
	}

	// Pan mode (Space key) — when active, pointer events fall through to ChartCell for pan
	let isPanModeActive = $state(false);
	const { handleKeyDown, handleKeyUp } = createPanModeHandlers((active) => {
		isPanModeActive = active;
	});

	// The axis the user is dragging on, by column
	let activeAxis: string | null = null;
	let anchor = 0;
	let current = 0;
	let isCapturing = false;
	let hasDragged = false;
	const point = { x: 0, y: 0 };

	// Animated x-positions from ChartScales (smooth transitions during reorder)
	const animPositions = $derived(chart.animatedAxisXPositions ?? []);

	// Axis x-positions indexed by DATA index — maps each column to its visual x-position
	// using axisOrder (which maps visual → data). Uses animated positions during reorder.
	const axisPositions = $derived.by(() => {
		if (!ps) return [];
		const n = ps.columns.length;
		const positions = new Array<number>(n);
		const useAnim = animPositions.length === n;
		for (let visualIdx = 0; visualIdx < n; visualIdx++) {
			const dataIdx = ps.axisOrder[visualIdx];
			positions[dataIdx] = useAnim
				? animPositions[visualIdx] * chart.innerWidth
				: n > 1
					? (visualIdx / (n - 1)) * chart.innerWidth
					: chart.innerWidth / 2;
		}
		return positions;
	});

	// Half the gap between axes — defines the brush strip width
	const brushHalfWidth = $derived.by(() => {
		if (!ps || ps.columns.length < 2) return 30;
		return Math.min(30, (chart.innerWidth / (ps.columns.length - 1)) * 0.35);
	});

	// Cross-filter: when cross=true, exclude chart's own marks (standard crossfilter).
	// When cross=false (default for parallel coords), empty set — all marks self-filter.
	const excludeMarkIds = cross
		? () => new Set(chart.config.entries.keys())
		: () => new Set<string>();

	/** An axis's scale state, looked up by column: removing a column renumbers the axes. */
	function scaleStateOf(col: string): LinearScaleState | null {
		if (!ps) return null;
		const i = ps.columns.indexOf(col);
		return i < 0 ? null : (ps.scaleStates[i] as LinearScaleState);
	}

	// Get D3 scale for an axis (y-direction)
	function getAxisScale(col: string): InvertibleScale | null {
		const state = scaleStateOf(col);
		if (!state) return null;
		const base = state.getBaseScale('y', chart.innerHeight);
		state.updateScaleDomain(base);
		return base as unknown as InvertibleScale;
	}

	// Find the axis (its column) whose brush strip contains an x-coordinate
	function nearestAxis(x: number): string | null {
		if (!ps || !axisPositions.length) return null;
		let bestIdx = 0;
		let bestDist = Math.abs(x - axisPositions[0]);
		for (let i = 1; i < axisPositions.length; i++) {
			const dist = Math.abs(x - axisPositions[i]);
			if (dist < bestDist) {
				bestDist = dist;
				bestIdx = i;
			}
		}
		return bestDist <= brushHalfWidth * 2 ? ps.columns[bestIdx] : null;
	}

	// Emit clause for a specific axis
	function emitUpdate(col: string) {
		const axis = axes.get(col);
		if (!axis?.brush.active) return;
		const { brush, lastEmitted } = axis;

		const dataMin = Math.min(brush.dataMin as number, brush.dataMax as number);
		const dataMax = Math.max(brush.dataMin as number, brush.dataMax as number);

		if (closeTo(dataMin, lastEmitted.min) && closeTo(dataMax, lastEmitted.max)) return;
		lastEmitted.min = dataMin;
		lastEmitted.max = dataMax;

		axis.handle.update(isBetween(column(col), [dataMin, dataMax]), [dataMin, dataMax]);
	}

	function clearBrush(col: string) {
		const axis = axes.get(col);
		if (!axis) return;
		axis.brush.clear();
		axis.lastEmitted.min = null;
		axis.lastEmitted.max = null;
		axis.handle.clear();
	}

	// --- Pointer handlers ---

	function handlePointerDown(event: PointerEvent, innerPoint: Point) {
		if (!ps) return false;
		if (isPanModeActive) return false; // Fall through to ChartCell for parallel axis pan

		const col = nearestAxis(innerPoint.x);
		if (col == null || !axes.has(col)) return false;

		(event.target as Element).setPointerCapture(event.pointerId);
		activeAxis = col;
		isCapturing = true;
		hasDragged = false;
		anchor = innerPoint.y;
		current = anchor;
		return true;
	}

	function handlePointerMove(event: PointerEvent, innerPoint: Point) {
		if (!isCapturing || activeAxis == null) {
			// A hover move: track the axis under the pointer, and let ChartCell go on.
			if (!isPanModeActive) hoverAxis(nearestAxis(innerPoint.x));
			return false;
		}

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		current = innerCoords.y;

		// The axis can have been removed mid-drag.
		const brush = axes.get(activeAxis)?.brush;
		if (!brush) return false;

		if (!hasDragged && isDragging(anchor, current)) {
			hasDragged = true;
			if (brush.phase === 'idle') {
				if (brush.active) clearBrush(activeAxis);
				brush.phase = 'creating';
			}
		}

		const s = getAxisScale(activeAxis);
		if (!s) return false;

		if (brush.phase === 'creating') {
			brush.setFromScreen(anchor, current, s);
		} else if (brush.phase === 'moving') {
			const delta = current - anchor;
			brush.shiftByScreen(delta, s);
			anchor = current;
		} else if (brush.phase === 'resizing') {
			// Parallel axes use inverted Y scales (top=max, bottom=min).
			// 'start'=top → moving dataMax, anchor is dataMin.
			// 'end'=bottom → moving dataMin, anchor is dataMax.
			const anchorData = brush.resizeEdge === 'start' ? brush.dataMin : brush.dataMax;
			const currentData = s.invert(current);
			brush.setExtent(
				Math.min(anchorData as number, currentData as number),
				Math.max(anchorData as number, currentData as number)
			);
		}

		emitUpdate(activeAxis);
		return true;
	}

	function handlePointerUp(event: PointerEvent) {
		if (!isCapturing || activeAxis == null) return false;

		(event.target as Element).releasePointerCapture(event.pointerId);
		isCapturing = false;

		const col = activeAxis;
		activeAxis = null;
		const brush = axes.get(col)?.brush;
		if (!brush) {
			hasDragged = false;
			return true;
		}

		if (!hasDragged && brush.active && (brush.phase === 'idle' || brush.phase === 'moving')) {
			clearBrush(col);
			return true;
		}

		if (brush.phase !== 'idle') {
			emitUpdate(col);
			brush.phase = 'idle';
		}

		hasDragged = false;
		return true;
	}

	function handleMoveStart(col: string, event: PointerEvent) {
		const brush = axes.get(col)?.brush;
		if (!brush) return;
		event.stopPropagation();
		// A drag that starts on a brush overlay hovers its axis, even without a
		// pointer move over the axis first.
		hoverAxis(col);
		(event.target as Element).setPointerCapture(event.pointerId);
		activeAxis = col;
		isCapturing = true;
		hasDragged = false;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchor = innerCoords.y;
		brush.phase = 'moving';
	}

	function handleResizeStart(col: string, edge: string, event: PointerEvent) {
		const brush = axes.get(col)?.brush;
		if (!brush) return;
		event.stopPropagation();
		hoverAxis(col);
		(event.target as Element).setPointerCapture(event.pointerId);
		activeAxis = col;
		isCapturing = true;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchor = innerCoords.y;
		brush.phase = 'resizing';
		brush.resizeEdge = edge === 'top' ? 'start' : 'end';
	}

	// Brush screen extents, one per active brush, at its axis's x-position —
	// derived for smooth reactive updates. The axes map is a SvelteMap, and each
	// BrushState1D's $state fields (dataMin/dataMax) are tracked transitively.
	const brushScreens = $derived.by(() => {
		if (!ps) return [];
		const screens: Array<{ col: string; x: number; pos: number; size: number }> = [];
		ps.columns.forEach((col, i) => {
			const brush = axes.get(col)?.brush;
			if (!brush?.active) return;
			const s = getAxisScale(col);
			if (!s) return;
			const [min, max] = brush.screenExtent(s);
			const clampedMin = Math.max(0, min);
			const clampedMax = Math.min(chart.innerHeight, max);
			if (clampedMax <= clampedMin) return;
			screens.push({
				col,
				x: axisPositions[i] - brushHalfWidth,
				pos: clampedMin,
				size: clampedMax - clampedMin
			});
		});
		return screens;
	});

	onMount(() => {
		chart.onInteractorPointerDown = handlePointerDown;
		chart.onInteractorPointerMove = handlePointerMove;
		chart.onInteractorPointerUp = handlePointerUp;
		chart.activators.add(activateHoveredAxis);

		return () => {
			chart.onInteractorPointerDown = null;
			chart.onInteractorPointerMove = null;
			chart.onInteractorPointerUp = null;
			chart.activators.delete(activateHoveredAxis);
		};
	});
</script>

<svelte:window onkeydown={handleKeyDown} onkeyup={handleKeyUp} />

{#if ps}
	{#each ps.columns as col (col)}
		<ParallelAxisSource
			{filterGroup}
			column={col}
			chartId={chart.chartId}
			{excludeMarkIds}
			scaleState={() => scaleStateOf(col)}
			pixelExtent={() => chart.innerHeight}
			{axes}
		/>
	{/each}
	{#each brushScreens as screen (screen.col)}
		<BrushOverlay
			x={screen.x}
			y={screen.pos}
			width={brushHalfWidth * 2}
			height={screen.size}
			orientation="y"
			onMoveStart={(e) => handleMoveStart(screen.col, e)}
			onResizeStart={(edge, e) => handleResizeStart(screen.col, edge, e)}
			onWheel={() => {}}
		/>
	{/each}
{/if}
