<script lang="ts">
	import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
	import { format } from 'd3-format';
	import { isBetween, column } from '@uwdata/mosaic-sql';
	import { scaleBrushExtent1D, WHEEL_SENSITIVITY } from '$lib/interactors/brush-utils';
	import { getContext, onDestroy } from 'svelte';
	import type { SourceHandle } from '$lib/query-engine/FilterGroup.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	interface Props {
		scaleState: ColorScaleState;
		selection?: string;
		title?: string | null;
		width?: number;
		height?: number;
		tickCount?: number;
		orientation?: 'horizontal' | 'vertical';
		className?: string;
	}

	let {
		scaleState,
		selection = undefined,
		title = null,
		width = 200,
		height = 12,
		tickCount = 5,
		orientation = 'horizontal',
		className = ''
	}: Props = $props();

	const STOP_COUNT = 32;
	const EDGE_THRESHOLD = 6;
	const TICK_GAP = 60; // px reserved for tick labels alongside the bar

	const effectiveTitle = $derived(title ?? scaleState.field ?? '');
	const isVertical = $derived(orientation === 'vertical');

	// --- Layout: orientation-independent bar dimensions ---
	const barLength = $derived(width); // length along the data axis
	const barThick = $derived(height); // cross-axis thickness
	const svgW = $derived(isVertical ? barThick + TICK_GAP : barLength);
	const svgH = $derived(isVertical ? barLength : barThick + 20);

	// --- Domain ---
	const domain = $derived(scaleState.domain as number[]);
	const min = $derived(domain[0] ?? 0);
	const max = $derived(domain[domain.length - 1] ?? 1);

	// --- Gradient ---
	const gradientStops = $derived.by(() => {
		void scaleState.scheme;
		void scaleState._version; // re-render on any visual-config change (transform, constant, exponent)
		if (!scaleState.d3Scale || min === max) return [];
		return Array.from({ length: STOP_COUNT }, (_, i) => {
			const t = i / (STOP_COUNT - 1);
			const value = min + t * (max - min);
			return {
				offset: `${t * 100}%`,
				color: scaleState.getColor(value)
			};
		});
	});

	const gradientId = `legend-gradient-${crypto.randomUUID().slice(0, 8)}`;

	// Gradient direction: horizontal flows left→right, vertical flows bottom→top
	const gradX1 = $derived(isVertical ? '0' : '0');
	const gradY1 = $derived(isVertical ? '1' : '0');
	const gradX2 = $derived(isVertical ? '0' : '1');
	const gradY2 = $derived(isVertical ? '0' : '0');

	// --- Ticks ---
	const MIN_TICK_PX = 36; // minimum pixels between tick labels

	const tickValues = $derived.by(() => {
		void scaleState._version;
		if (min === max) return [min];
		const range = max - min;
		// Ask for generous candidates — D3 picks nice values,
		// then the pixel filter keeps only the ones that fit.
		const raw = scaleState.ticks(tickCount * 4);
		if (raw.length <= 1 || barLength <= 0) return raw;

		const valToPx = (v: number) => ((v - min) / range) * barLength;

		// Greedily keep ticks that are far enough apart in pixel space
		const result: number[] = [raw[0]];
		let lastPx = valToPx(raw[0]);
		for (let i = 1; i < raw.length; i++) {
			const px = valToPx(raw[i]);
			if (px - lastPx >= MIN_TICK_PX) {
				result.push(raw[i]);
				lastPx = px;
			}
		}
		return result;
	});

	const formatTick = format('~s');
	const formatHover = format('.3~s');

	// --- Coordinate helpers ---
	// Convert t (0-1 in data space) to bar-axis pixel position
	function tToPx(t: number): number {
		return isVertical ? barLength * (1 - t) : barLength * t;
	}

	// Bar rect position: always at origin, dimensions swapped by orientation
	const barX = 0;
	const barY = 0;
	const barW = $derived(isVertical ? barThick : barLength);
	const barH = $derived(isVertical ? barLength : barThick);

	// --- Hover crosshair ---
	let hoverT: number | null = $state(null);
	const hoverValue = $derived(hoverT != null ? min + hoverT * (max - min) : null);

	function getTFromPointer(e: PointerEvent | WheelEvent, clamp = false): number {
		const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
		if (isVertical) {
			let y = e.clientY - rect.top;
			if (clamp) y = Math.max(0, Math.min(y, barLength));
			return 1 - y / barLength;
		} else {
			let x = e.clientX - rect.left;
			if (clamp) x = Math.max(0, Math.min(x, barLength));
			return x / barLength;
		}
	}

	function onPointerMove(e: PointerEvent) {
		hoverT = getTFromPointer(e, true);
	}

	// Hovering the legend prepares its preagg tables, before the first drag.
	function onPointerEnter() {
		brushHandle?.activate();
	}

	function onPointerLeave() {
		if (!isDragging) hoverT = null;
	}

	// --- Brush state ---
	const filterGroups = getContext<FilterGroupRegistry | undefined>('filter-groups');
	const filterGroup = filterGroups?.get(selection);
	const isInteractive = $derived(filterGroup != null);

	let brushT0: number | null = $state(null);
	let brushT1: number | null = $state(null);
	const hasBrush = $derived(brushT0 != null && brushT1 != null);

	// Clamped for rendering — data extent preserved for drag-back
	const visT0 = $derived(hasBrush ? Math.max(0, brushT0!) : 0);
	const visT1 = $derived(hasBrush ? Math.min(1, brushT1!) : 0);
	const hasBrushVisible = $derived(hasBrush && visT1 > visT0);

	// Brush domain values (unclamped — emitted as filter)
	const brushMin = $derived(brushT0 != null ? min + brushT0 * (max - min) : null);
	const brushMax = $derived(brushT1 != null ? min + brushT1 * (max - min) : null);

	// --- Selection wiring ---
	const sourceId = `legend-color-${scaleState.field}`;
	const columnRef = $derived(column(scaleState.field));

	const brushHandle: SourceHandle | null = filterGroup
		? filterGroup.register(sourceId, {
				// No chart: an interval cannot dim, so the chart it sits in filters by
				// it rather than showing nothing.
				// The brush maps the bar linearly onto [min, max], whatever the color
				// transform, so its pixel bins do too: barLength pixels over the domain.
				activeDims: () =>
					min === max
						? []
						: [
								{
									kind: 'bin',
									columnRef,
									domain: [min, max],
									pixelExtent: barLength,
									extent: [min, max]
								}
							],
				// Read on every query: plain numbers, nothing allocated. The legend
				// never zooms; only new data moves its domain.
				view: (out) => {
					out[0] = min;
					out[1] = max;
					out[2] = barLength;
				},
				augment: (value) => ({
					kind: 'range',
					column: scaleState.field,
					label: scaleState.field,
					values: value ? [(value as number[])[0], (value as number[])[1]] : []
				}),
				// The clause was removed from outside (clearAll, a filter pill): take the
				// brush down too, which only this legend holds.
				onCleared: () => {
					brushT0 = null;
					brushT1 = null;
				}
			})
		: null;

	onDestroy(() => brushHandle?.destroy());

	function emitBrush() {
		if (!brushHandle || brushMin == null || brushMax == null) return;
		brushHandle.update(isBetween(columnRef, [brushMin, brushMax]), [brushMin, brushMax]);
	}

	function clearBrush() {
		brushT0 = null;
		brushT1 = null;
		brushHandle?.clear();
	}

	// --- Drag interaction ---
	type DragMode = 'create' | 'move' | 'resize-low' | 'resize-high';
	let isDragging = false;
	let hasDragged = false;
	let dragMode: DragMode = 'create';
	let dragAnchor = 0;
	let dragOffset = 0;

	function hitTest(t: number): DragMode {
		if (!hasBrush) return 'create';
		const lowPx = brushT0! * barLength;
		const highPx = brushT1! * barLength;
		const pointerPx = t * barLength;

		if (Math.abs(pointerPx - lowPx) < EDGE_THRESHOLD) return 'resize-low';
		if (Math.abs(pointerPx - highPx) < EDGE_THRESHOLD) return 'resize-high';
		if (t > brushT0! && t < brushT1!) return 'move';
		return 'create';
	}

	let cursorStyle = $state('crosshair');
	const resizeCursor = $derived(isVertical ? 'ns-resize' : 'ew-resize');

	function updateCursor(t: number) {
		if (!isInteractive || !hasBrush) {
			cursorStyle = 'crosshair';
			return;
		}
		const mode = hitTest(t);
		cursorStyle = mode === 'create' ? 'crosshair' : resizeCursor;
	}

	function onPointerDown(e: PointerEvent) {
		if (!isInteractive) return;
		e.preventDefault();
		const t = getTFromPointer(e);
		dragMode = hitTest(t);
		dragAnchor = t;
		isDragging = true;
		hasDragged = false;

		if (dragMode === 'move') {
			dragOffset = t - brushT0!;
			cursorStyle = resizeCursor;
		} else if (dragMode === 'create') {
			brushT0 = t;
			brushT1 = t;
		}

		(e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
	}

	function onDragMove(e: PointerEvent) {
		if (!isDragging) {
			onPointerMove(e);
			if (isInteractive) updateCursor(hoverT!);
			return;
		}
		e.preventDefault();
		const t = getTFromPointer(e);
		hoverT = t;

		if (!hasDragged && Math.abs(t - dragAnchor) * barLength > 3) {
			hasDragged = true;
		}

		if (dragMode === 'create') {
			brushT0 = Math.min(dragAnchor, t);
			brushT1 = Math.max(dragAnchor, t);
		} else if (dragMode === 'move') {
			const span = brushT1! - brushT0!;
			const newLow = t - dragOffset;
			brushT0 = newLow;
			brushT1 = newLow + span;
		} else if (dragMode === 'resize-low') {
			brushT0 = Math.min(t, brushT1! - 0.01);
		} else if (dragMode === 'resize-high') {
			brushT1 = Math.max(t, brushT0! + 0.01);
		}

		emitBrush();
	}

	function onPointerUp(e: PointerEvent) {
		if (!isDragging) return;
		isDragging = false;

		if (!hasDragged && hasBrush) {
			clearBrush();
			cursorStyle = 'crosshair';
			return;
		}

		if (hasBrush && Math.abs(brushT1! - brushT0!) < 0.01) {
			clearBrush();
		} else {
			emitBrush();
		}

		if (hoverT != null) updateCursor(hoverT);
	}

	function onDblClick() {
		if (hasBrush) clearBrush();
	}

	function onWheel(e: WheelEvent) {
		if (!e.shiftKey || !hasBrush || !isInteractive) return;
		e.preventDefault();
		e.stopPropagation();

		const scaleFactor = 1 + e.deltaY * WHEEL_SENSITIVITY;
		const [newMin, newMax] = scaleBrushExtent1D(brushMin!, brushMax!, scaleFactor);

		const range = max - min;
		brushT0 = (newMin - min) / range;
		brushT1 = (newMax - min) / range;

		emitBrush();
	}
</script>

{#snippet crosshairLine(mainPos: number, crossStart: number, crossEnd: number)}
	{@const x1 = isVertical ? crossStart : mainPos}
	{@const y1 = isVertical ? mainPos : crossStart}
	{@const x2 = isVertical ? crossEnd : mainPos}
	{@const y2 = isVertical ? mainPos : crossEnd}
	<line {x1} {y1} {x2} {y2} stroke="white" stroke-width={1.5} class="legend-crosshair" />
	<line {x1} {y1} {x2} {y2} stroke="black" stroke-width={0.5} class="legend-crosshair" />
{/snippet}

{#snippet tickLabel(mainPos: number, value: number)}
	{@const anchor = isVertical ? 'start' : 'middle'}
	{@const tx = isVertical ? barThick + 6 : mainPos}
	{@const ty = isVertical ? mainPos : barThick + 6}
	{@const dy = isVertical ? '0.35em' : '0.71em'}
	<line
		x1={isVertical ? barThick : mainPos}
		y1={isVertical ? mainPos : barThick}
		x2={isVertical ? barThick + 4 : mainPos}
		y2={isVertical ? mainPos : barThick + 4}
		stroke="currentColor"
		stroke-width={0.5}
	/>
	<text x={tx} y={ty} {dy} text-anchor={anchor} class="legend-tick-label">{formatTick(value)}</text>
{/snippet}

{#snippet hoverLabel(mainPos: number, value: number)}
	{@const anchor = isVertical ? 'start' : 'middle'}
	{@const tx = isVertical ? barThick + 6 : mainPos}
	{@const ty = isVertical ? mainPos : barThick + 6}
	{@const dy = isVertical ? '0.35em' : '0.71em'}
	<text x={tx} y={ty} {dy} text-anchor={anchor} class="legend-hover-label legend-hover-halo"
		>{formatHover(value)}</text
	>
	<text x={tx} y={ty} {dy} text-anchor={anchor} class="legend-hover-label"
		>{formatHover(value)}</text
	>
{/snippet}

{#snippet brushMask(lo: number, hi: number)}
	<rect
		x={isVertical ? 0 : lo}
		y={isVertical ? lo : 0}
		width={isVertical ? barThick : hi - lo}
		height={isVertical ? hi - lo : barThick}
		class="legend-brush-mask"
	/>
{/snippet}

{#if gradientStops.length > 0}
	<div class="legend-continuous {className}" class:legend-vertical={isVertical}>
		{#if effectiveTitle}
			<span class="legend-title">{effectiveTitle}</span>
		{/if}

		<svg
			width={svgW}
			height={svgH}
			class="legend-svg"
			style:cursor={cursorStyle}
			onpointermove={onDragMove}
			onpointerenter={onPointerEnter}
			onpointerleave={onPointerLeave}
			onpointerdown={onPointerDown}
			onpointerup={onPointerUp}
			ondblclick={onDblClick}
			onwheel={onWheel}
		>
			<defs>
				<linearGradient id={gradientId} x1={gradX1} y1={gradY1} x2={gradX2} y2={gradY2}>
					{#each gradientStops as stop, i (i)}
						<stop offset={stop.offset} stop-color={stop.color} />
					{/each}
				</linearGradient>
			</defs>

			<!-- Gradient bar -->
			<rect x={barX} y={barY} width={barW} height={barH} fill="url(#{gradientId})" />

			<!-- Brush overlays -->
			{#if hasBrushVisible}
				{@const loEdge = tToPx(isVertical ? visT1 : visT0)}
				{@const hiEdge = tToPx(isVertical ? visT0 : visT1)}
				{@render brushMask(0, loEdge)}
				{@render brushMask(hiEdge, barLength)}
				<rect
					x={isVertical ? 0 : loEdge}
					y={isVertical ? loEdge : 0}
					width={isVertical ? barThick : hiEdge - loEdge}
					height={isVertical ? hiEdge - loEdge : barThick}
					class="legend-brush-extent"
				/>
			{/if}

			<!-- Tick marks -->
			{#each tickValues as tick, i (i)}
				{@render tickLabel(tToPx((tick - min) / (max - min)), tick)}
			{/each}

			<!-- Hover crosshair -->
			{#if hoverT != null && hoverValue != null && !hasBrush}
				{@const pos = tToPx(hoverT)}
				{@render crosshairLine(pos, 0, barThick)}
				{@render hoverLabel(pos, hoverValue)}
			{/if}
		</svg>
	</div>
{/if}

<style>
	.legend-continuous {
		font-family: var(--fjader-font, system-ui, sans-serif);
		font-size: 10px;
		pointer-events: auto;
	}

	.legend-title {
		font-weight: 700;
		display: block;
		margin-bottom: 4px;
	}

	.legend-svg {
		display: block;
		overflow: visible;
	}

	.legend-tick-label {
		font-size: 10px;
		fill: var(--fjader-text-secondary, #6b7280);
	}

	.legend-crosshair {
		pointer-events: none;
	}

	.legend-hover-halo {
		stroke: var(--fjader-bg, white);
		stroke-width: 3px;
		stroke-linejoin: round;
		pointer-events: none;
	}

	.legend-hover-label {
		font-size: 10px;
		font-weight: 600;
		fill: var(--fjader-text-secondary, #6b7280);
		pointer-events: none;
	}

	.legend-brush-mask {
		fill: var(--fjader-bg, white);
		opacity: 0.65;
		pointer-events: none;
	}

	.legend-brush-extent {
		fill: transparent;
		stroke: var(--fjader-text-secondary, #6b7280);
		stroke-width: 1;
		pointer-events: none;
	}
</style>
