<script lang="ts">
	/**
	 * A DerivedInterval1D in one cell: draws the derived range (held once for
	 * the chart, by the declaration) as a ghost brush, clamped to this cell's
	 * scale and size.
	 */
	import { getContext } from 'svelte';
	import GhostBrushOverlay from './GhostBrushOverlay.svelte';
	import type { ChartContext } from '$lib/types';

	interface Props {
		/** The derived range in data space, or null when there is none. */
		extent: () => [number, number] | null;
		axis: 'x' | 'y';
		label: string;
	}

	const { extent, axis, label }: Props = $props();
	const chart = getContext<ChartContext>('chart');
	const isX = axis === 'x';

	// The range in this cell's pixels, clamped to the plot.
	const overlayScreen = $derived.by(() => {
		const range = extent();
		const s = isX ? chart.xScale : chart.yScale;
		if (!range || !s) return null;
		const p0 = s(Math.min(range[0], range[1]));
		const p1 = s(Math.max(range[0], range[1]));
		const lo = Math.max(0, Math.min(p0, p1));
		const hi = Math.min(isX ? chart.innerWidth : chart.innerHeight, Math.max(p0, p1));
		return hi > lo ? { pos: lo, size: hi - lo } : null;
	});
</script>

{#if overlayScreen}
	<GhostBrushOverlay
		x={isX ? overlayScreen.pos : 0}
		y={isX ? 0 : overlayScreen.pos}
		width={isX ? overlayScreen.size : chart.innerWidth}
		height={isX ? chart.innerHeight : overlayScreen.size}
		{label}
	/>
{/if}
