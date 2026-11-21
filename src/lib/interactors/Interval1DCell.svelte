<script lang="ts">
	/**
	 * An Interval1D in one cell: hooks the cell's pointer events into the
	 * brush's drag (IntervalShared, held once for the chart), through this
	 * cell's scale, and draws the range. What needs the cell stays here: its
	 * pointer capture, scale, inner size and pan-mode keys.
	 */
	import { getContext, onDestroy, onMount } from 'svelte';
	import BrushOverlay from './BrushOverlay.svelte';
	import { createPanModeHandlers, brushHandleAt, WHEEL_SENSITIVITY } from './brush-utils';
	import type { ChartContext, Point } from '$lib/types';
	import type { IntervalDrag1D, IntervalShared } from './interval-drag.svelte';

	interface Props {
		shared: IntervalShared<IntervalDrag1D>;
		axis: 'x' | 'y';
	}

	const { shared, axis }: Props = $props();
	const chart = getContext<ChartContext>('chart');
	const { drag } = shared;
	const { brush } = drag;
	const isX = axis === 'x';

	/** This cell's scale on the brush's axis; read on each event (mutated in place). */
	const scale = () => (isX ? chart.xScale : chart.yScale);

	/** This cell measures the brush's pixels from now on (CellPixels). */
	const activate = () => {
		shared.pixels.use(chart);
		shared.activate();
	};
	chart.activators.add(activate);

	onDestroy(() => {
		chart.activators.delete(activate);
		// A drag this cell held ends here; its size stays the brush's until
		// another cell activates it.
		drag.abandon(chart);
		shared.pixels.release(chart);
	});

	let isPanModeActive = false;
	const { handleKeyDown, handleKeyUp, handleBlur } = createPanModeHandlers(
		(active) => {
			isPanModeActive = active;
		},
		() => chart.reroutePress()
	);

	// Reused for pointer conversion.
	const point = { x: 0, y: 0 };

	// The range in this cell's pixels. Reads chart.xScale/yScale directly so the
	// domain getter registers as a dependency (the D3 scale object's identity
	// never changes, so an intermediate $derived would swallow updates).
	const brushScreen = $derived.by(() => {
		const s = isX ? chart.xScale : chart.yScale;
		if (!brush.active || !s) return null;
		const [min, max] = brush.screenExtent(s);
		// Clamped for drawing only: the data range is kept, so a brush dragged
		// past the edge keeps its size when dragged back.
		const dim = isX ? chart.innerWidth : chart.innerHeight;
		const lo = Math.max(0, min);
		const hi = Math.min(dim, max);
		return hi > lo ? { pos: lo, size: hi - lo } : null;
	});

	/**
	 * A press: move or resize on the brush's handles, else draw; decline in pan
	 * mode. While another cell's drag is under way (a second pointer), take the
	 * press and do nothing, rather than let the cell pan.
	 */
	function handlePointerDown(target: Element, pointerId: number, innerPoint: Point) {
		if (isPanModeActive) return false;
		if (drag.held) return true;
		const hit = brushHandleAt(target);
		if (!drag.press(chart, isX ? innerPoint.x : innerPoint.y, hit?.handle ?? null)) return false;
		try {
			target.setPointerCapture(pointerId);
		} catch {
			// Without capture no release may reach this cell, and a drag held
			// waiting for one would block the brush in every cell.
			drag.abandon(chart);
			return false;
		}
		shared.pixels.use(chart);
		return true;
	}

	function handlePointerMove(event: PointerEvent) {
		if (!drag.owns(chart)) return false;
		point.x = event.offsetX;
		point.y = event.offsetY;
		const inner = chart.toInnerCoordinates(point);
		return drag.move(chart, isX ? inner.x : inner.y, scale());
	}

	function handlePointerUp(event: PointerEvent) {
		if (!drag.owns(chart)) return false;
		(event.target as Element).releasePointerCapture(event.pointerId);
		return drag.release(chart);
	}

	/** The chart re-routes the press: end the drag as it stands, never as a click. */
	function handleDragEnd() {
		drag.abandon(chart);
	}

	function handleWheel(event: WheelEvent) {
		if (!event.shiftKey) return;
		event.preventDefault();
		event.stopPropagation();
		drag.zoom(1 + event.deltaY * WHEEL_SENSITIVITY);
	}

	// Register pointer callbacks; the keys are on <svelte:window> below.
	onMount(() => {
		// A cell has one pointer-down hook: a second brush in it (IntervalX and
		// IntervalY together) would silently replace the first.
		if (chart.onInteractorPointerDown)
			console.warn(
				'fjader: a chart cell already has a brush; Interval1D replaces it. ' +
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

{#if brush.active && brushScreen}
	<BrushOverlay
		x={isX ? brushScreen.pos : 0}
		y={isX ? 0 : brushScreen.pos}
		width={isX ? brushScreen.size : chart.innerWidth}
		height={isX ? chart.innerHeight : brushScreen.size}
		orientation={axis}
		onWheel={handleWheel}
	/>
{/if}
