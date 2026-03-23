<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { clauseInterval } from '@uwdata/mosaic-core';
	import { column } from '@uwdata/mosaic-sql';
	import { BrushState1D } from './brush-state.svelte';
	import BrushOverlay from './BrushOverlay.svelte';
	import { closeTo, isDragging, createPanModeHandlers } from './brush-utils';
	import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import { getSelectionRegistry } from '$lib/selection';
	import type { ChartContext, Point } from '$lib/types';
	import type { ClauseSource, Selection } from '@uwdata/mosaic-core';
	import type { ScaleDomain } from '@uwdata/mosaic-sql';

	type InvertibleScale = { (v: unknown): number; invert(v: number): number; domain(): number[]; range(): number[] };

	interface Props {
		selection?: string;
		/** When true, the parallel chart excludes itself from its own brush filters
		 *  (standard crossfilter behavior). When false (default), brushes self-filter
		 *  the chart — typical for parallel coordinates. */
		cross?: boolean;
	}

	let { selection: selectionName = 'brush', cross = false }: Props = $props();

	const chart = getContext<ChartContext>('chart');
	const group = getSelectionRegistry()!.getGroup(selectionName);

	const ps = $derived(chart.parallelScales);

	// --- Per-axis state (created once per column) ---
	const brushes: BrushState1D[] = [];
	const selections: (Selection | null)[] = [];
	const unregisters: (() => void)[] = [];
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

	// Axis x-positions (pixels, matching GPU shader axisXPosition formula)
	const axisPositions = $derived.by(() => {
		if (!ps) return [];
		const n = ps.columns.length;
		return ps.columns.map((_, i) =>
			n > 1 ? (i / (n - 1)) * chart.innerWidth : chart.innerWidth / 2
		);
	});

	// Half the gap between axes — defines the brush strip width
	const brushHalfWidth = $derived.by(() => {
		if (!ps || ps.columns.length < 2) return 30;
		return Math.min(30, (chart.innerWidth / (ps.columns.length - 1)) * 0.35);
	});

	// Ensure per-axis arrays are sized correctly
	function ensureAxisState(n: number) {
		while (brushes.length < n) {
			const i = brushes.length;
			const col = ps!.columns[i];
			brushes.push(new BrushState1D());
			lastEmitted.push({ min: null, max: null });

			const source = `parallel-brush-${col}-${chart.chartId}`;
			const { sel, off } = group.createLocal('single', {
				source,
				augment: (clause) => ({
					kind: 'range',
					column: col,
					label: col,
					values: clause?.value
						? [(clause.value as number[])[0], (clause.value as number[])[1]]
						: []
				}),
				onVisualClear: () => {
					brushes[i].clear();
					lastEmitted[i] = { min: null, max: null };
				}
			});
			selections.push(sel);
			unregisters.push(off);
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

		const sel = selections[i];
		if (!sel) return;

		const col = ps.columns[i];
		const s = getAxisScale(i);
		if (!s) return;

		const clause = clauseInterval(column(col), [dataMin, dataMax] as ScaleDomain, {
			source: `parallel-brush-${col}-${chart.chartId}` as unknown as ClauseSource,
			clients: cross ? chart.markClients : new Set(),
			scale: {
				type: 'linear',
				domain: s.domain() as ScaleDomain,
				range: s.range() as [number, number]
			}
		});
		sel.update(clause);
	}

	function clearBrush(i: number) {
		brushes[i].clear();
		lastEmitted[i] = { min: null, max: null };

		const sel = selections[i];
		if (sel && ps) {
			sel.update({
				predicate: null,
				source: `parallel-brush-${ps.columns[i]}-${chart.chartId}` as unknown as ClauseSource,
				clients: cross ? chart.markClients : new Set(),
				value: null
			});
		}
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
			const anchorData = brush.resizeEdge === 'start' ? brush.dataMax : brush.dataMin;
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
		if (!ps) return;
		ensureAxisState(ps.columns.length);
		for (let i = 0; i < ps.columns.length; i++) {
			const sel = selections[i];
			if (!sel?.activate) continue;
			const col = ps.columns[i];
			const s = getAxisScale(i);
			if (!s) continue;
			const brush = brushes[i];
			const range: ScaleDomain = brush.active
				? [
						Math.min(brush.dataMin as number, brush.dataMax as number),
						Math.max(brush.dataMin as number, brush.dataMax as number)
					]
				: [0, 1];
			sel.activate(
				clauseInterval(column(col), range, {
					source: `parallel-brush-${col}-${chart.chartId}` as unknown as ClauseSource,
					clients: cross ? chart.markClients : new Set(),
					scale: {
						type: 'linear',
						domain: s.domain() as ScaleDomain,
						range: s.range() as [number, number]
					}
				})
			);
		}
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

	// Brush screen extents — derived for smooth reactive updates
	const brushScreens = $derived.by(() => {
		if (!ps) return [];
		ensureAxisState(ps.columns.length);
		return ps.scaleStates.map((state, i) => {
			const brush = brushes[i];
			if (!brush?.active) return null;
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

		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);

		return () => {
			chart.onInteractorPointerDown = null;
			chart.onInteractorPointerMove = null;
			chart.onInteractorPointerUp = null;
			chart.onInteractorPointerEnter = null;
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
			for (const off of unregisters) off?.();
		};
	});
</script>

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
