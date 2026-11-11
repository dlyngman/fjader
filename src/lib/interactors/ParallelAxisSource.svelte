<script lang="ts" module>
	import type { SourceHandle } from '$lib/query-engine/FilterGroup.svelte';
	import { BrushState1D } from './brush-state.svelte';

	/** One parallel axis's state, kept by column for as long as the column is an axis. */
	export interface ParallelAxis {
		/** The column's selection source. */
		handle: SourceHandle;
		brush: BrushState1D;
		/** The extent last written to the clause, to skip unchanged frames. */
		lastEmitted: { min: number | null; max: number | null };
	}
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { SvelteMap } from 'svelte/reactivity';
	import { column as sqlColumn } from '@uwdata/mosaic-sql';
	import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { FilterGroup } from '$lib/query-engine/FilterGroup.svelte';

	/**
	 * One parallel axis's selection source, so a brush on that axis filters its
	 * column. Renders nothing: it exists for its lifecycle.
	 *
	 * ParallelBrushes keys one of these per column, so the axis's state (its
	 * source registration and its brush) lives exactly as long as the column is
	 * an axis, and is there before its first drag (its preagg tables can then
	 * be built on hover). Removing the column unmounts it, which clears its
	 * filter and drops its brush; a column added back starts with none, and no
	 * other axis's brush moves. It declares one pixel-binned
	 * dim on its column, at the axis scale's spring target, so a table built
	 * while the axis still moves fits the view it settles on.
	 */

	interface Props {
		filterGroup: FilterGroup;
		column: string;
		chartId: string;
		/** The chart the brush skips, or null for a chart that filters its own lines. */
		chart: object | null;
		/** The axis's scale state now: removing another column renumbers the axes. */
		scaleState: () => LinearScaleState | null;
		/** The axes' pixel extent (the chart's inner height). */
		pixelExtent: () => number;
		/** Where ParallelBrushes finds this column's axis state. */
		axes: SvelteMap<string, ParallelAxis>;
	}

	// Keyed by column in the parent, so none of these change for an instance.
	const { filterGroup, column, chartId, chart, scaleState, pixelExtent, axes }: Props = $props();

	const columnRef = sqlColumn(column);

	const handle = filterGroup.register(`parallel-brush-${column}-${chartId}`, {
		chart,
		activeDims: () => {
			const state = scaleState();
			if (!state) return [];
			return [
				{
					kind: 'bin',
					columnRef,
					domain: state.domain.target,
					pixelExtent: pixelExtent(),
					// For the size guard: how many bins the data spans at this zoom.
					extent: state.effectiveExtent
				}
			];
		},
		// Read on every query: the scale state's target buffer is reused, so this
		// allocates nothing.
		view: (out) => {
			const state = scaleState();
			if (!state) return;
			const domain = state.domain.targetBuffer;
			out[0] = domain[0];
			out[1] = domain[1];
			out[2] = pixelExtent();
		},
		augment: (value) => ({
			kind: 'range',
			column,
			label: column,
			values: value ? [(value as number[])[0], (value as number[])[1]] : []
		}),
		// The clause was removed from outside (clearAll, a filter pill): take this
		// axis's rectangle down too, which only ParallelBrushes' state holds.
		onCleared: () => {
			const axis = axes.get(column);
			if (!axis) return;
			axis.brush.clear();
			axis.lastEmitted.min = null;
			axis.lastEmitted.max = null;
		}
	});

	axes.set(column, { handle, brush: new BrushState1D(), lastEmitted: { min: null, max: null } });

	onDestroy(() => {
		axes.delete(column);
		handle.destroy();
	});
</script>
