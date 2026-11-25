<script lang="ts">
	/**
	 * ParallelBrushes in one cell: places the axes at this cell's width, finds
	 * the axis under the pointer, drives that axis's drag (held once for the
	 * chart, in the declaration's axes) through this cell's scale, and draws
	 * every axis's range. What needs the cell stays here: its width and height,
	 * hover, pointer capture and pan-mode keys.
	 */
	import { getContext, onDestroy, onMount } from 'svelte';
	import type { SvelteMap } from 'svelte/reactivity';
	import BrushOverlay from './BrushOverlay.svelte';
	import type { ParallelAxis } from './ParallelAxisSource.svelte';
	import { createPanModeHandlers, brushHandleAt, WHEEL_SENSITIVITY } from './brush-utils';
	import type { CellPixels, DragScale } from './interval-drag.svelte';
	import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { ChartContext, Point } from '$lib/types';

	interface Props {
		/** Each axis's source and drag, by column (the declaration's). */
		axes: SvelteMap<string, ParallelAxis>;
		/** The axes' pixel extent, measured in the cell that last activated them. */
		pixels: CellPixels;
	}

	const { axes, pixels }: Props = $props();
	const chart = getContext<ChartContext>('chart');

	const ps = $derived(chart.parallelScales);

	/**
	 * The axis whose brush strip the pointer is in, by column, or null between
	 * strips. Only this axis's source is activated: one source per axis means
	 * one set of preagg tables per axis, and building every axis's on chart
	 * hover would be axes × marks builds, most for axes never brushed.
	 */
	let hoveredAxis: string | null = null;

	/** Activate `col`'s source, measured in this cell. */
	function activateAxis(col: string) {
		pixels.use(chart);
		axes.get(col)?.handle.activate();
	}

	/** Make `col` the hovered axis; activate its source when it changes. A batch
	 *  of its own, so moving to another axis drops the previous one's queued builds. */
	function hoverAxis(col: string | null) {
		if (col === hoveredAxis) return;
		hoveredAxis = col;
		if (col) activateAxis(col);
	}

	/** The cell's activator (hover, settling): the hovered axis, if any. */
	function activateHoveredAxis() {
		if (hoveredAxis) activateAxis(hoveredAxis);
	}
	chart.activators.add(activateHoveredAxis);

	/** The axis this cell is dragging, by column; its drag is the axis's. */
	let activeAxis: string | null = null;

	onDestroy(() => {
		chart.activators.delete(activateHoveredAxis);
		// A drag this cell held ends here; its size stays the axes' until
		// another cell activates them.
		if (activeAxis != null) axes.get(activeAxis)?.drag.abandon(chart);
		pixels.release(chart);
	});

	// Pan mode (Space key) — when active, pointer events fall through to ChartCell for pan
	let isPanModeActive = false;
	const { handleKeyDown, handleKeyUp, handleBlur } = createPanModeHandlers(
		(active) => {
			isPanModeActive = active;
		},
		() => chart.reroutePress()
	);

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

	/** An axis's scale state, looked up by column: removing a column renumbers the axes. */
	function scaleStateOf(col: string): LinearScaleState | null {
		if (!ps) return null;
		const i = ps.columns.indexOf(col);
		return i < 0 ? null : (ps.scaleStates[i] as LinearScaleState);
	}

	// An axis's D3 scale (y-direction), at this cell's height
	function getAxisScale(col: string): DragScale | null {
		const state = scaleStateOf(col);
		if (!state) return null;
		const base = state.getBaseScale('y', chart.innerHeight);
		state.updateScaleDomain(base);
		return base as unknown as DragScale;
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

	// --- Pointer handlers ---

	/**
	 * A press: move or resize on an axis's brush handles (that axis, from the
	 * overlay's owner), else draw on the nearest axis; decline in pan mode.
	 * While another cell drags the same axis (a second pointer), take the press
	 * and do nothing; another axis's drag doesn't stop it. Nor does a second
	 * pointer in this cell while it drags an axis: taking it would leave that
	 * axis's drag held by this cell, with no release to come.
	 */
	function handlePointerDown(target: Element, pointerId: number, innerPoint: Point) {
		if (!ps) return false;
		if (activeAxis != null) return true;
		if (isPanModeActive) return false; // Fall through to ChartCell for parallel axis pan

		const hit = brushHandleAt(target);
		const col = hit?.owner ?? nearestAxis(innerPoint.x);
		const axis = col == null ? undefined : axes.get(col);
		if (col == null || !axis) return false;
		if (axis.drag.held) return true;
		// A drag that starts on a brush overlay hovers its axis, even without a
		// pointer move over the axis first.
		if (hit) hoverAxis(col);

		if (!axis.drag.press(chart, pointerId, innerPoint.y, hit?.handle ?? null)) return false;
		try {
			target.setPointerCapture(pointerId);
		} catch {
			// Without capture no release may reach this cell, and a drag held
			// waiting for one would block the axis in every cell.
			axis.drag.abandon(chart);
			return false;
		}
		activeAxis = col;
		pixels.use(chart);
		return true;
	}

	/** Whether `event` is another pointer's than the one this cell drags `axis` with. */
	function otherPointer(axis: ParallelAxis, event: PointerEvent) {
		return axis.drag.owns(chart) && !axis.drag.owns(chart, event.pointerId);
	}

	function handlePointerMove(event: PointerEvent, innerPoint: Point) {
		if (activeAxis == null) {
			// A hover move: track the axis under the pointer, and let ChartCell go on.
			if (!isPanModeActive) hoverAxis(nearestAxis(innerPoint.x));
			return false;
		}
		const axis = axes.get(activeAxis);
		// Another pointer's move (a second finger or pen) is not this drag's.
		if (axis && otherPointer(axis, event)) return false;
		// The axis can have been removed mid-drag (its drag went with it), its
		// scale gone before its source, or its drag no longer this cell's (its
		// source remounted, or ended another way): let go rather than hold
		// activeAxis, which would swallow every later press in this cell.
		const s = getAxisScale(activeAxis);
		if (!axis || !s || !axis.drag.owns(chart)) {
			axis?.drag.abandon(chart);
			activeAxis = null;
			return false;
		}
		// The cell's point, not the event's offsetX: that is measured from the event's
		// target, which is not always the chart's SVG.
		return axis.drag.move(chart, event.pointerId, innerPoint.y, s);
	}

	function handlePointerUp(event: PointerEvent) {
		if (activeAxis == null) return false;
		const axis = axes.get(activeAxis);
		// Another pointer's release (a second finger or pen) does not end this drag.
		if (axis && otherPointer(axis, event)) return false;
		activeAxis = null;
		(event.target as Element).releasePointerCapture(event.pointerId);
		// A press that never moved is a click, which clears the axis's brush.
		return axis ? axis.drag.release(chart, event.pointerId) : true;
	}

	/** The chart re-routes the press, or it lost capture: end the drag as it stands. */
	function handleDragEnd() {
		if (activeAxis == null) return;
		const col = activeAxis;
		activeAxis = null;
		axes.get(col)?.drag.abandon(chart);
	}

	/** Shift+wheel on an axis's rectangle: scale it about its centre, as the other brushes do. */
	function handleWheel(event: WheelEvent, col: string) {
		if (!event.shiftKey) return;
		event.preventDefault();
		event.stopPropagation();
		axes.get(col)?.drag.zoom(1 + event.deltaY * WHEEL_SENSITIVITY);
	}

	// Brush screen extents, one per active brush, at its axis's x-position —
	// derived for smooth reactive updates. The axes map is a SvelteMap, and each
	// brush's $state fields (dataMin/dataMax) are tracked transitively.
	const brushScreens = $derived.by(() => {
		if (!ps) return [];
		const screens: Array<{ col: string; x: number; pos: number; size: number }> = [];
		ps.columns.forEach((col, i) => {
			const brush = axes.get(col)?.drag.brush;
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
		// A cell has one pointer-down hook: a second brush in it (IntervalX and
		// IntervalY together) would silently replace the first.
		if (chart.onInteractorPointerDown)
			console.warn(
				'fjader: a chart cell already has a brush; ParallelBrushes replaces it. ' +
					'Use one brush per chart (Interval2D for both axes).'
			);
		chart.onInteractorPointerDown = handlePointerDown;
		chart.onInteractorPointerMove = handlePointerMove;
		chart.onInteractorPointerUp = handlePointerUp;
		chart.onInteractorDragEnd = handleDragEnd;

		return () => {
			// Only if they are still this brush's: another brush in the cell may
			// have taken them since (the warning above), and keeps them.
			if (chart.onInteractorPointerDown === handlePointerDown) {
				chart.onInteractorPointerDown = null;
				chart.onInteractorPointerMove = null;
				chart.onInteractorPointerUp = null;
				chart.onInteractorDragEnd = null;
			}
		};
	});
</script>

<svelte:window onkeydown={handleKeyDown} onkeyup={handleKeyUp} onblur={handleBlur} />

{#if ps}
	{#each brushScreens as screen (screen.col)}
		<BrushOverlay
			x={screen.x}
			y={screen.pos}
			width={brushHalfWidth * 2}
			height={screen.size}
			orientation="y"
			owner={screen.col}
			onWheel={(event) => handleWheel(event, screen.col)}
		/>
	{/each}
{/if}
