<script lang="ts" module>
	import type { SourceHandle } from '$lib/query-engine/FilterGroup.svelte';
	import type { IntervalDrag1D } from './interval-drag.svelte';

	/** One parallel axis's state, kept by column for as long as the column is an axis. */
	export interface ParallelAxis {
		/** The column's selection source. */
		handle: SourceHandle;
		/** The axis's brush: its range in data space and the drag a cell holds on it. */
		drag: IntervalDrag1D;
	}
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { SvelteMap } from 'svelte/reactivity';
	import { column as sqlColumn, isBetween } from '@uwdata/mosaic-sql';
	import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { FilterGroup } from '$lib/query-engine/FilterGroup.svelte';
	import { IntervalDrag1D as Drag, type CellPixels } from './interval-drag.svelte';

	/**
	 * One parallel axis's selection source and brush, so a brush on that axis
	 * filters its column. Renders nothing: it exists for its lifecycle.
	 *
	 * The ParallelBrushes declaration keys one of these per column, once per
	 * chart, so the axis's state (its source registration and its drag) lives
	 * exactly as long as the column is an axis, and is there before its first
	 * drag (its preagg tables can then be built on hover). Removing the column
	 * unmounts it, which clears its filter and drops its brush; a column added
	 * back starts with none, and no other axis's brush moves. It declares one
	 * pixel-binned dim on its column, at the axis scale's spring target, so a
	 * table built while the axis still moves fits the view it settles on.
	 */

	interface Props {
		filterGroup: FilterGroup;
		column: string;
		/** Whose source this is: the chart, or the cell of a per-cell snippet. */
		owner: string;
		/** The chart the brush skips, or null for a chart that filters its own lines. */
		chart: object | null;
		/** The axis's scale state now: removing another column renumbers the axes. */
		scaleState: () => LinearScaleState | null;
		/** The axes' pixels: the inner height of the cell that last activated them. */
		pixels: CellPixels;
		/** Where the cells find this column's axis state. */
		axes: SvelteMap<string, ParallelAxis>;
	}

	// Keyed by column in the parent, so none of these change for an instance.
	const { filterGroup, column, owner, chart, scaleState, pixels, axes }: Props = $props();

	const columnRef = sqlColumn(column);

	/** False once destroyed: a cell still dragging this axis must not write. */
	let live = true;

	const drag = new Drag({
		range(min, max) {
			if (!live) return false;
			handle.update(isBetween(columnRef, [min, max]), [min, max]);
			return true;
		},
		clear() {
			if (live) handle.clear();
		}
	});

	const handle = filterGroup.register(`parallel-brush-${column}-${owner}`, {
		chart,
		activeDims: () => {
			const state = scaleState();
			if (!state || !pixels.height) return [];
			return [
				{
					kind: 'bin',
					columnRef,
					domain: state.domain.target,
					pixelExtent: pixels.height,
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
			out[2] = pixels.height;
		},
		augment: (value) => ({
			kind: 'range',
			column,
			label: column,
			values: value ? [(value as number[])[0], (value as number[])[1]] : []
		}),
		// The clause was removed from outside (clearAll, a filter pill): take this
		// axis's rectangle down too, which only its drag holds.
		onCleared: () => {
			if (drag.brush.active) drag.clear();
		}
	});

	axes.set(column, { handle, drag });

	onDestroy(() => {
		live = false;
		axes.delete(column);
		handle.destroy();
	});
</script>
