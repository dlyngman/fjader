<script lang="ts">
	/**
	 * An Interval2D in one cell: hooks the cell's pointer events into the
	 * brush's drag (IntervalShared, held once for the chart), through this
	 * cell's scales, and draws the rectangle. What needs the cell stays here:
	 * its pointer capture, scales, inner size and pan-mode keys.
	 */
	import { getContext, onDestroy, onMount } from 'svelte';
	import BrushOverlay from './BrushOverlay.svelte';
	import { createPanModeHandlers, brushHandleAt, WHEEL_SENSITIVITY } from './brush-utils';
	import type { ChartContext, Point } from '$lib/types';
	import type { IntervalDrag2D, IntervalShared } from './interval-drag.svelte';

	interface Props {
		shared: IntervalShared<IntervalDrag2D>;
	}

	const { shared }: Props = $props();
	const chart = getContext<ChartContext>('chart');
	const { drag } = shared;
	const { brush } = drag;

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

	// The rectangle in this cell's pixels, clamped for drawing only: the data
	// range is kept.
	const brushScreen = $derived.by(() => {
		if (!brush.active) return null;
		const [xMin, xMax] = brush.x.screenExtent(chart.xScale);
		const [yMin, yMax] = brush.y.screenExtent(chart.yScale);
		const cx0 = Math.max(0, xMin);
		const cx1 = Math.min(chart.innerWidth, xMax);
		const cy0 = Math.max(0, yMin);
		const cy1 = Math.min(chart.innerHeight, yMax);
		if (cx1 <= cx0 || cy1 <= cy0) return null;
		return { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 };
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
		if (!drag.press(chart, pointerId, innerPoint.x, innerPoint.y, hit?.handle ?? null))
			return false;
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

	function handlePointerMove(event: PointerEvent, inner: Point) {
		// Another pointer's (a second finger or pen) is not this drag's: ChartCell handles it.
		if (!drag.owns(chart, event.pointerId)) return false;
		// The cell's point, not the event's offsetX: that is measured from the event's
		// target, which is not always the chart's SVG.
		return drag.move(chart, event.pointerId, inner.x, inner.y, chart.xScale, chart.yScale);
	}

	function handlePointerUp(event: PointerEvent) {
		// Another pointer's (a second finger or pen) is not this drag's: ChartCell handles it.
		if (!drag.owns(chart, event.pointerId)) return false;
		(event.target as Element).releasePointerCapture(event.pointerId);
		return drag.release(chart, event.pointerId);
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
				'fjader: a chart cell already has a brush; Interval2D replaces it. ' +
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
		x={brushScreen.x}
		y={brushScreen.y}
		width={brushScreen.width}
		height={brushScreen.height}
		orientation="2d"
		onWheel={handleWheel}
	/>
{/if}
