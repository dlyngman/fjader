<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { isBetween, column } from '@uwdata/mosaic-sql';
	import { BrushState1D } from './brush-state.svelte';
	import BrushOverlay from './BrushOverlay.svelte';
	import { closeTo, isDragging, createPanModeHandlers } from './brush-utils';
	import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { ChartContext, Point } from '$lib/types';
	import type { BrushHandle } from '$lib/query-engine/FilterGroup.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';

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
	const queryEngine = getContext<QueryEngine>('query-engine');

	const ps = $derived(chart.parallelScales);

	// --- Per-axis state (one per column, grown when columns are added) ---
	let brushes = $state<BrushState1D[]>([]);
	const handles: BrushHandle[] = [];
	const lastEmitted: { min: number | null; max: number | null }[] = [];

	// Pan mode (Space key) — when active, pointer events fall through to ChartCell for pan
	let isPanModeActive = $state(false);
	const { handleKeyDown, handleKeyUp } = createPanModeHandlers((active) => {
		isPanModeActive = active;
	});

	// Active brush index (which axis the user is currently interacting with)
	let activeAxisIdx: number | null = null;
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

	// Ensure per-axis arrays are sized correctly
	function ensureAxisState(n: number) {
		while (brushes.length < n) {
			const i = brushes.length;
			const col = ps!.columns[i];
			brushes.push(new BrushState1D());
			lastEmitted.push({ min: null, max: null });

			const sourceId = `parallel-brush-${col}-${chart.chartId}`;
			handles.push(
				filterGroup.createBrush({
					sourceId,
					excludeMarkIds,
					augment: (value) => ({
						kind: 'range',
						column: col,
						label: col,
						values: value ? [(value as number[])[0], (value as number[])[1]] : []
					})
				})
			);
		}
	}

	// Get D3 scale for an axis (y-direction)
	function getAxisScale(i: number): InvertibleScale | null {
		if (!ps) return null;
		const state = ps.scaleStates[i] as LinearScaleState;
		const base = state.getBaseScale('y', chart.innerHeight);
		state.updateScaleDomain(base);
		return base as unknown as InvertibleScale;
	}

	// Find nearest axis from an x-coordinate
	function nearestAxis(x: number): number | null {
		if (!axisPositions.length) return null;
		let bestIdx = 0;
		let bestDist = Math.abs(x - axisPositions[0]);
		for (let i = 1; i < axisPositions.length; i++) {
			const dist = Math.abs(x - axisPositions[i]);
			if (dist < bestDist) {
				bestDist = dist;
				bestIdx = i;
			}
		}
		return bestDist <= brushHalfWidth * 2 ? bestIdx : null;
	}

	// Emit clause for a specific axis
	function emitUpdate(i: number) {
		const brush = brushes[i];
		if (!brush.active || !ps) return;

		const dataMin = Math.min(brush.dataMin as number, brush.dataMax as number);
		const dataMax = Math.max(brush.dataMin as number, brush.dataMax as number);

		if (closeTo(dataMin, lastEmitted[i].min) && closeTo(dataMax, lastEmitted[i].max)) return;
		lastEmitted[i] = { min: dataMin, max: dataMax };

		const col = ps.columns[i];
		handles[i].update(isBetween(column(col), [dataMin, dataMax]), [dataMin, dataMax]);
	}

	function clearBrush(i: number) {
		brushes[i].clear();
		lastEmitted[i] = { min: null, max: null };
		handles[i].clear();
	}

	// --- Pointer handlers ---

	function handlePointerDown(event: PointerEvent, innerPoint: Point) {
		if (!ps) return false;
		if (isPanModeActive) return false; // Fall through to ChartCell for parallel axis pan
		ensureAxisState(ps.columns.length);

		const axisIdx = nearestAxis(innerPoint.x);
		if (axisIdx == null) return false;

		(event.target as Element).setPointerCapture(event.pointerId);
		activeAxisIdx = axisIdx;
		isCapturing = true;
		hasDragged = false;
		anchor = innerPoint.y;
		current = anchor;
		return true;
	}

	function handlePointerMove(event: PointerEvent) {
		if (!isCapturing || activeAxisIdx == null) return false;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		current = innerCoords.y;

		const brush = brushes[activeAxisIdx];

		if (!hasDragged && isDragging(anchor, current)) {
			hasDragged = true;
			if (brush.phase === 'idle') {
				if (brush.active) clearBrush(activeAxisIdx);
				brush.phase = 'creating';
			}
		}

		const s = getAxisScale(activeAxisIdx);
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

		emitUpdate(activeAxisIdx);
		return true;
	}

	function handlePointerUp(event: PointerEvent) {
		if (!isCapturing || activeAxisIdx == null) return false;

		(event.target as Element).releasePointerCapture(event.pointerId);
		isCapturing = false;

		const brush = brushes[activeAxisIdx];

		if (!hasDragged && brush.active && (brush.phase === 'idle' || brush.phase === 'moving')) {
			clearBrush(activeAxisIdx);
			activeAxisIdx = null;
			return true;
		}

		if (brush.phase !== 'idle') {
			emitUpdate(activeAxisIdx);
			brush.phase = 'idle';
		}

		hasDragged = false;
		activeAxisIdx = null;
		return true;
	}

	function handlePointerEnter() {
		// ParallelBrushes operates on raw rows — no aggregation to pre-aggregate.
		queryEngine.activate(filterGroup, new Set(chart.config.entries.keys()), []);
	}

	function handleMoveStart(i: number, event: PointerEvent) {
		event.stopPropagation();
		(event.target as Element).setPointerCapture(event.pointerId);
		activeAxisIdx = i;
		isCapturing = true;
		hasDragged = false;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchor = innerCoords.y;
		brushes[i].phase = 'moving';
	}

	function handleResizeStart(i: number, edge: string, event: PointerEvent) {
		event.stopPropagation();
		(event.target as Element).setPointerCapture(event.pointerId);
		activeAxisIdx = i;
		isCapturing = true;

		point.x = event.offsetX;
		point.y = event.offsetY;
		const innerCoords = chart.toInnerCoordinates(point);
		anchor = innerCoords.y;
		brushes[i].phase = 'resizing';
		brushes[i].resizeEdge = edge === 'top' ? 'start' : 'end';
	}

	// Brush screen extents — derived for smooth reactive updates.
	// brushes is $state so Svelte tracks element access, and each
	// BrushState1D's $state fields (dataMin/dataMax) are tracked transitively.
	const brushScreens = $derived.by(() => {
		if (!ps || brushes.length === 0) return [];
		return brushes.map((brush, i) => {
			if (!brush.active) return null;
			const s = getAxisScale(i);
			if (!s) return null;
			const [min, max] = brush.screenExtent(s);
			const clampedMin = Math.max(0, min);
			const clampedMax = Math.min(chart.innerHeight, max);
			if (clampedMax <= clampedMin) return null;
			return { pos: clampedMin, size: clampedMax - clampedMin };
		});
	});

	onMount(() => {
		chart.onInteractorPointerDown = handlePointerDown;
		chart.onInteractorPointerMove = handlePointerMove;
		chart.onInteractorPointerUp = handlePointerUp;
		chart.onInteractorPointerEnter = handlePointerEnter;

		return () => {
			chart.onInteractorPointerDown = null;
			chart.onInteractorPointerMove = null;
			chart.onInteractorPointerUp = null;
			chart.onInteractorPointerEnter = null;
			for (const h of handles) h.destroy();
		};
	});
</script>

<svelte:window onkeydown={handleKeyDown} onkeyup={handleKeyUp} />

{#if ps}
	{#each brushScreens as screen, i}
		{#if screen && brushes[i]?.active}
			<BrushOverlay
				x={axisPositions[i] - brushHalfWidth}
				y={screen.pos}
				width={brushHalfWidth * 2}
				height={screen.size}
				orientation="y"
				onMoveStart={(e) => handleMoveStart(i, e)}
				onResizeStart={(edge, e) => handleResizeStart(i, edge, e)}
				onWheel={() => {}}
			/>
		{/if}
	{/each}
{/if}
