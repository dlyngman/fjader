<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { ScaleContinuousNumeric } from 'd3-scale';

	interface Props {
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
	}

	let { ticksNumber = 5, tickFormat = null }: Props = $props();
	const c = getContext<ChartContext>('chart');

	const ps = $derived(c.parallelScales);

	// Evenly-spaced visual positions (N slots)
	function visualX(visualIdx: number, n: number): number {
		return n > 1 ? (visualIdx / (n - 1)) * c.innerWidth : c.innerWidth / 2;
	}

	// Animated x-positions from ChartScales (smooth transitions during reorder)
	const animPositions = $derived(c.animatedAxisXPositions ?? []);

	// Returns axes in VISUAL order (axisOrder applied), new array each animation frame.
	const axes = $derived.by(() => {
		if (!ps) return [];
		const n = ps.columns.length;
		const order = ps.axisOrder;
		return order.map((dataIdx, visualIdx) => {
			const s = ps.scaleStates[dataIdx] as LinearScaleState;
			const ticks = s.getTicks(ticksNumber);
			const base = s.getBaseScale('y', c.innerHeight);
			s.updateScaleDomain(base);
			const fmt = tickFormat ?? s.tickFormat(ticksNumber);
			// Use animated position if available, else evenly spaced
			const xNorm = animPositions.length === n ? animPositions[visualIdx] : (n > 1 ? visualIdx / (n - 1) : 0.5);
			return {
				dataIdx,
				visualIdx,
				column: ps.columns[dataIdx],
				ticks,
				scale: base as ScaleContinuousNumeric<number, number>,
				fmt,
				x: xNorm * c.innerWidth
			};
		});
	});

	// Reorder drag state from ChartContext — tracked by stable data index
	const reorder = $derived(c.parallelReorderState);
	const dragDataIdx = $derived(reorder?.dataIdx ?? null);
	const dragX = $derived(reorder?.currentX ?? null);
</script>

{#if c.isReady && axes.length > 0}
	{#each axes as axis, vi (axis.dataIdx)}
		{@const anchor = vi === 0 ? 'end' : vi === axes.length - 1 ? 'start' : 'middle'}
		{@const labelX = vi === 0 ? -8 : vi === axes.length - 1 ? 8 : 0}
		{@const isDragging = dragDataIdx === axis.dataIdx}
		{@const axisX = axis.x}
		<g
			class="parallel-axis"
			class:dragging={isDragging}
			transform="translate({axisX}, 0)"
		>
			<line x1={0} x2={0} y1={0} y2={c.innerHeight} class="axis-line" />

			{#each axis.ticks as tick, j (j)}
				{@const y = axis.scale(tick)}
				<line x1={-4} x2={4} y1={y} y2={y} class="tick-line" />
				<text class="tick-halo" text-anchor={anchor} dominant-baseline="middle" x={labelX} y={y}>
					{axis.fmt(tick)}
				</text>
				<text class="tick-label" text-anchor={anchor} dominant-baseline="middle" x={labelX} y={y}>
					{axis.fmt(tick)}
				</text>
			{/each}

			<text
				class="axis-label"
				class:axis-label-dragging={isDragging}
				text-anchor="middle"
				y={c.innerHeight + 20}
			>
				{axis.column}
			</text>
		</g>
	{/each}

	<!-- Drop indicator line -->
	{#if dragDataIdx != null && dragX != null && ps}
		{@const n = ps.columns.length}
		{@const dragVisualIdx = ps.axisOrder.indexOf(dragDataIdx)}
		{@const slots = Array.from({ length: n }, (_, i) => visualX(i, n))}
		{@const closestSlot = slots.reduce((best, x, i) =>
			Math.abs(dragX - x) < Math.abs(dragX - slots[best]) ? i : best, 0)}
		{#if closestSlot !== dragVisualIdx}
			<line
				x1={slots[closestSlot]}
				x2={slots[closestSlot]}
				y1={-5}
				y2={c.innerHeight + 5}
				class="drop-indicator"
			/>
		{/if}
	{/if}
{/if}

<style>
	.axis-line {
		stroke: var(--diveplot-text-secondary, #6b7280);
		stroke-width: 1;
	}

	.tick-line {
		stroke: var(--diveplot-text-secondary, #6b7280);
	}

	.tick-halo {
		fill: none;
		stroke: var(--diveplot-bg, #ffffff);
		stroke-width: 3px;
		stroke-linejoin: round;
		font-family: var(--diveplot-font, system-ui, sans-serif);
		font-size: 10px;
	}

	.tick-label {
		fill: var(--diveplot-text-secondary, #6b7280);
		font-family: var(--diveplot-font, system-ui, sans-serif);
		font-size: 10px;
	}

	.axis-label {
		font-size: 11px;
		font-weight: 500;
		fill: var(--diveplot-text-primary, #374151);
	}

	.axis-label-dragging {
		fill: var(--diveplot-accent, #3b82f6);
	}

	.dragging {
		opacity: 0.6;
	}

	.drop-indicator {
		stroke: var(--diveplot-accent, #3b82f6);
		stroke-width: 2;
		stroke-dasharray: 4 3;
	}
</style>
