<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { isBetween } from '@uwdata/mosaic-sql';
	import { BrushState1D } from './brush-state.svelte';
	import BrushOverlay from './BrushOverlay.svelte';
	import {
		buildColumnRef,
		closeTo,
		isDragging,
		scaleBrushExtent1D,
		createPanModeHandlers,
		WHEEL_SENSITIVITY
	} from './brush-utils';
	import type { ChartContext, FieldRef, Point, D3Scale } from '$lib/types';
	import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { SourceHandle } from '$lib/query-engine/FilterGroup.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	/** Helper: cast D3Scale to one with invert() for continuous scales. */
	type InvertibleScale = D3Scale & { invert(v: number): number | Date };

	interface Props {
		/** Filter group name — selects which FilterGroup this brush writes to. */
		selection?: string;
		field?: FieldRef;
		axis?: 'x' | 'y';
	}

	let { selection, field, axis = 'x' }: Props = $props();

	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const filterGroup = filterGroups.get(selection);

	const chart = getContext<ChartContext>('chart');
	const brush = new BrushState1D();
	const isX = axis === 'x';

	// Axis-dependent references
	// Use a getter instead of $derived — the D3 scale object identity never changes
	// (domain is mutated in place), so $derived would swallow updates.
	function getScale() {
		return isX ? chart.xScale : chart.yScale;
	}
	const scaleState = $derived(isX ? chart.xScaleState : chart.yScaleState);
	const resolvedField = $derived(
		field ?? (isX ? chart.xColumnName : chart.yColumnName) ?? (isX ? chart.xLabel : chart.yLabel)
	);

	// Resize edge names
	const edgeStart = isX ? 'left' : 'top';
	const edgeEnd = isX ? 'right' : 'bottom';

	// Source string — single definition used everywhere
	const source = `interval-${axis}-${chart.chartId}`;

	const columnRef = $derived.by(() =>
		buildColumnRef(
			resolvedField,
			scaleState && 't0' in scaleState ? (scaleState as { t0?: Date | null }) : null
		)
	);

	const brushHandle: SourceHandle = filterGroup.register(source, {
		excludeMarkIds: () => new Set(chart.config.entries.keys()),
		activeDims: () => {
			const scale = getScale();
			if (!scale || !columnRef) return [];
			return [
				{
					kind: 'bin',
					columnRef,
					domain: scale.domain() as [number, number],
					pixelExtent: isX ? chart.innerWidth : chart.innerHeight,
					// For the size guard: how many bins the data spans at this zoom.
					extent: scaleState instanceof LinearScaleState ? scaleState.effectiveExtent : undefined
				}
			];
		},
		// Read on every query: the scale state's domain buffer is reused, so this
		// allocates nothing.
		view: (out) => {
			if (!(scaleState instanceof LinearScaleState)) return;
			const domain = scaleState.domain.current;
			out[0] = domain[0];
			out[1] = domain[1];
			out[2] = isX ? chart.innerWidth : chart.innerHeight;
		},
		augment: (value) => ({
			kind: 'range',
			column: typeof resolvedField === 'string' ? resolvedField : (resolvedField?.toString() ?? ''),
			label: typeof resolvedField === 'string' ? resolvedField : resolvedField?.toString(),
			values: value ? [(value as number[])[0], (value as number[])[1]] : []
		})
	});

	// Pointer state (reused to avoid GC)
	let anchor = 0;
	let current = 0;
	let isCapturing = false;
	let hasDragged = false;
	let isPanModeActive = $state(false);

	// Reusable point object to reduce GC pressure
	const point = { x: 0, y: 0 };

	// Deduplication (skip redundant updates)
	let lastEmittedMin: number | null = null;
	let lastEmittedMax: number | null = null;

	// Keyboard handlers for Space key pan mode
	const { handleKeyDown, handleKeyUp } = createPanModeHandlers((active) => {
		isPanModeActive = active;
	});

	// Scale validation
	// Always validate as 'linear': DivePlot time scales use float offsets, not Dates,
	// so the 'time' validation (requires Date instances) would incorrectly clear the brush.
	$effect(() => {
		const s = getScale();
		if (brush.active && s && !brush.validate(s as { domain: () => number[] }, 'linear')) {
			clearBrush();
		}
	});

	// Watch for external selection changes (from detail chart pan/zoom)
	// to keep brush visual in sync and update Mosaic filter
	$effect(() => {
		if (!(scaleState instanceof LinearScaleState)) return;
		const extent = scaleState.selectionExtent;
		if (extent && scaleState.selectionSource === 'external') {
			brush.setExtent(extent[0], extent[1]);
			lastEmittedMin = extent[0];
			lastEmittedMax = extent[1];
			emitFilterClause(extent[0], extent[1]);
		} else if (!extent && brush.active) {
			// Selection was cleared externally (e.g. detail chart reset) — clear brush
			clearBrush();
		}
	});

	// Derived screen coordinates — read chart.xScale/yScale directly so the
	// domainForReactivity getter registers as a dependency (the D3 scale object
	// identity never changes, so an intermediate $derived would swallow updates).
	const brushScreen = $derived.by(() => {
		const s = isX ? chart.xScale : chart.yScale;
		if (!brush.active || !s) return null;
		const [min, max] = brush.screenExtent(s);
		// Clamp screen coordinates to chart bounds for rendering only —
		// the underlying data extent is preserved so the brush retains its
		// full size when dragged back from beyond the edge.
		const dim = isX ? chart.innerWidth : chart.innerHeight;
		const clampedMin = Math.max(0, min);
		const clampedMax = Math.min(dim, max);
		if (clampedMax <= clampedMin) return null;
		return { pos: clampedMin, size: clampedMax - clampedMin };
	});

	// Read the axis-relevant inner coordinate from a point
	function innerCoord(innerPoint: Point) {
		return isX ? innerPoint.x : innerPoint.y;
	}

	function emitFilterClause(dataMin: number, dataMax: number) {
		if (!columnRef) return;
		brushHandle.update(isBetween(columnRef, [dataMin, dataMax]), [dataMin, dataMax]);
	}

	// Update scale selectionExtent and optionally emit Mosaic clause
	function emitUpdate() {
		if (!brush.active) return;

		const dataMin = Math.min(brush.dataMin as number, brush.dataMax as number);
		const dataMax = Math.max(brush.dataMin as number, brush.dataMax as number);

		if (closeTo(dataMin, lastEmittedMin) && closeTo(dataMax, lastEmittedMax)) {
			return;
		}

		lastEmittedMin = dataMin;
		lastEmittedMax = dataMax;

		// Always set selectionExtent on the scale (for useXSelection consumers)
		if (scaleState instanceof LinearScaleState) {
			scaleState.setSelectionExtent(dataMin, dataMax, 'brush');
		}

		emitFilterClause(dataMin, dataMax);
	}

	function handleWheel(event: WheelEvent) {
		if (!event.shiftKey) return;

		event.preventDefault();
		event.stopPropagation();

		const scaleFactor = 1 + event.deltaY * WHEEL_SENSITIVITY;

		const min = Math.min(brush.dataMin as number, brush.dataMax as number);
		const max = Math.max(brush.dataMin as number, brush.dataMax as number);

		const [newMin, newMax] = scaleBrushExtent1D(min, max, scaleFactor);
		brush.setExtent(newMin, newMax);

		emitUpdate();
	}

	function clearBrush() {
		brush.clear();
		lastEmittedMin = null;
		lastEmittedMax = null;

		if (scaleState instanceof LinearScaleState) {
			scaleState.clearSelectionExtent();
		}

		brushHandle.clear();
	}

	// --- Pointer Event Handlers (registered as chart context callbacks) ---

	function handlePointerDown(event: PointerEvent, innerPoint: Point) {
		if (brush.phase !== 'idle') return false;
		if (isPanModeActive) return false;

		(event.target as Element).setPointerCapture(event.pointerId);
		isCapturing = true;
		hasDragged = false;

		anchor = innerCoord(innerPoint);
		current = anchor;
		return true;
	}

	function handlePointerMove(event: PointerEvent) {
		if (!isCapturing) return false;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		current = innerCoord(innerCoords);

		if (!hasDragged && isDragging(anchor, current)) {
			hasDragged = true;
			if (brush.phase === 'idle') {
				if (brush.active) {
					clearBrush();
				}
				brush.phase = 'creating';
			}
		}

		const s = getScale() as InvertibleScale;
		if (brush.phase === 'creating') {
			brush.setFromScreen(anchor, current, s);
		} else if (brush.phase === 'moving') {
			const delta = current - anchor;
			brush.shiftByScreen(delta, s);
			anchor = current;
		} else if (brush.phase === 'resizing') {
			const anchorData = brush.resizeEdge === 'start' ? brush.dataMax : brush.dataMin;
			const currentData = s.invert(current);
			brush.setExtent(
				Math.min(anchorData as number, currentData as number),
				Math.max(anchorData as number, currentData as number)
			);
		}

		emitUpdate();
		return true;
	}

	function handlePointerUp(event: PointerEvent) {
		if (!isCapturing) return false;

		(event.target as Element).releasePointerCapture(event.pointerId);
		isCapturing = false;

		if (!hasDragged && brush.active && (brush.phase === 'idle' || brush.phase === 'moving')) {
			clearBrush();
			return true;
		}

		if (brush.phase !== 'idle') {
			emitUpdate();
			brush.phase = 'idle';
		}

		hasDragged = false;
		return true;
	}

	function handleMoveStart(event: PointerEvent) {
		event.stopPropagation();
		(event.target as Element).setPointerCapture(event.pointerId);
		isCapturing = true;
		hasDragged = false;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchor = innerCoord(innerCoords);
		brush.phase = 'moving';
	}

	function handleResizeStart(edge: string, event: PointerEvent) {
		event.stopPropagation();
		(event.target as Element).setPointerCapture(event.pointerId);
		isCapturing = true;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchor = innerCoord(innerCoords);
		brush.phase = 'resizing';
		brush.resizeEdge = edge === edgeStart ? 'start' : 'end';
	}

	// Register pointer callbacks; the keys are on <svelte:window> below.
	onMount(() => {
		chart.onInteractorPointerDown = handlePointerDown;
		chart.onInteractorPointerMove = handlePointerMove;
		chart.onInteractorPointerUp = handlePointerUp;
		chart.activators.add(brushHandle.activate);

		return () => {
			chart.onInteractorPointerDown = null;
			chart.onInteractorPointerMove = null;
			chart.onInteractorPointerUp = null;
			chart.activators.delete(brushHandle.activate);
			brushHandle.destroy();
		};
	});
</script>

<svelte:window onkeydown={handleKeyDown} onkeyup={handleKeyUp} />

{#if brush.active && brushScreen}
	<BrushOverlay
		x={isX ? brushScreen.pos : 0}
		y={isX ? 0 : brushScreen.pos}
		width={isX ? brushScreen.size : chart.innerWidth}
		height={isX ? chart.innerHeight : brushScreen.size}
		orientation={axis}
		onMoveStart={handleMoveStart}
		onResizeStart={handleResizeStart}
		onWheel={handleWheel}
	/>
{/if}
