<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { clauseInterval } from '@uwdata/mosaic-core';
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
	import type { FilterBridge } from '$lib/selection/filter-bridge.svelte';
	import type { ClauseSource } from '@uwdata/mosaic-core';
	import type { ScaleDomain } from '@uwdata/mosaic-sql';

	/** Helper: cast D3Scale to one with invert() for continuous scales. */
	type InvertibleScale = D3Scale & { invert(v: number): number | Date };

	interface Props {
		bridge: FilterBridge;
		field?: FieldRef;
		axis?: 'x' | 'y';
	}

	let { bridge, field, axis = 'x' }: Props = $props();

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
	const resolvedField = $derived(field ?? (isX ? chart.xLabel : chart.yLabel));

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

	// Register with FilterBridge to get a local Selection
	const { sel: selection, off: unregister } = bridge.createLocal('single', {
		source,
		augment: (clause) => ({
			kind: 'range',
			column: typeof resolvedField === 'string' ? resolvedField : resolvedField?.toString() ?? '',
			label: typeof resolvedField === 'string' ? resolvedField : resolvedField?.toString(),
			values: clause?.value ? [(clause.value as number[])[0], (clause.value as number[])[1]] : []
		}),
		onVisualClear: () => brush.clear()
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
	let lastEmittedMin = null;
	let lastEmittedMax = null;

	// Keyboard handlers for Space key pan mode
	const { handleKeyDown, handleKeyUp } = createPanModeHandlers((active) => {
		isPanModeActive = active;
	});

	// Scale validation
	$effect(() => {
		const scaleType = scaleState?.scaleType;
		const s = getScale();
		if (brush.active && scaleType && !brush.validate(s as { domain: () => number[] }, scaleType)) {
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
		return { pos: min, size: max - min };
	});

	// Read the axis-relevant inner coordinate from a point
	function innerCoord(innerPoint: Point) {
		return isX ? innerPoint.x : innerPoint.y;
	}

	// Emit Mosaic clause
	function emitClause() {
		if (!brush.active || !columnRef) return;

		const dataMin = Math.min(brush.dataMin as number, brush.dataMax as number);
		const dataMax = Math.max(brush.dataMin as number, brush.dataMax as number);

		if (closeTo(dataMin, lastEmittedMin) && closeTo(dataMax, lastEmittedMax)) {
			return;
		}

		lastEmittedMin = dataMin;
		lastEmittedMax = dataMax;

		const s = getScale();
		const clause = clauseInterval(columnRef, [dataMin, dataMax] as ScaleDomain, {
			source: source as unknown as ClauseSource,
			clients: chart.markClients,
			scale: {
				type: scaleState?.scaleType || 'linear',
				domain: s!.domain() as ScaleDomain,
				range: s!.range() as [number, number]
			}
		});

		selection.update(clause);
	}

	// Pre-aggregation on pointer enter
	function handlePointerEnter() {
		const s = getScale();
		if (!selection.activate || !s || !columnRef) return;

		const range: ScaleDomain = brush.active
			? [Math.min(brush.dataMin as number, brush.dataMax as number), Math.max(brush.dataMin as number, brush.dataMax as number)]
			: [0, 1];

		selection.activate(
			clauseInterval(columnRef, range, {
				source: source as unknown as ClauseSource,
				clients: chart.markClients,
				scale: {
					type: scaleState?.scaleType || 'linear',
					domain: s!.domain() as ScaleDomain,
					range: s!.range() as [number, number]
				}
			})
		);
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

		emitClause();
	}

	function clearBrush() {
		brush.clear();
		selection.update({
			predicate: null,
			source: source as unknown as ClauseSource,
			clients: chart.markClients,
			value: null
		});
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
			brush.setExtent(Math.min(anchorData as number, currentData as number), Math.max(anchorData as number, currentData as number));
		}

		emitClause();
		return true;
	}

	function handlePointerUp(event: PointerEvent) {
		if (!isCapturing) return false;

		(event.target as Element).releasePointerCapture(event.pointerId);
		isCapturing = false;

		if (!hasDragged && brush.active && brush.phase === 'idle') {
			clearBrush();
			return true;
		}

		if (brush.phase !== 'idle') {
			emitClause();
			brush.phase = 'idle';
		}

		hasDragged = false;
		return true;
	}

	function handleMoveStart(event: PointerEvent) {
		event.stopPropagation();
		(event.target as Element).setPointerCapture(event.pointerId);
		isCapturing = true;

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

	// Register callbacks and keyboard listeners
	onMount(() => {
		chart.onInteractorPointerDown = handlePointerDown;
		chart.onInteractorPointerMove = handlePointerMove;
		chart.onInteractorPointerUp = handlePointerUp;
		chart.onInteractorPointerEnter = handlePointerEnter;

		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);

		return () => {
			chart.onInteractorPointerDown = null;
			chart.onInteractorPointerMove = null;
			chart.onInteractorPointerUp = null;
			chart.onInteractorPointerEnter = null;
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
			unregister();
		};
	});
</script>

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
