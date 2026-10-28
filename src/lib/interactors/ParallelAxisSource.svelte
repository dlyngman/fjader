<script lang="ts">
	import { onDestroy } from 'svelte';
	import { column as sqlColumn } from '@uwdata/mosaic-sql';
	import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { FilterGroup, SourceHandle } from '$lib/query-engine/FilterGroup.svelte';

	/**
	 * One parallel axis's selection source, so a brush on that axis filters its
	 * column. Renders nothing: it exists for its lifecycle.
	 *
	 * ParallelBrushes keys one of these per column, so the registration lives
	 * exactly as long as the column is an axis, and is registered before its
	 * first drag (its preagg tables can then be built on hover). Removing the
	 * column unmounts it, which clears its filter. It declares one pixel-binned
	 * dim on its column, at the axis scale's spring target, so a table built
	 * while the axis still moves fits the view it settles on.
	 */

	interface Props {
		filterGroup: FilterGroup;
		column: string;
		chartId: string;
		excludeMarkIds: () => Set<string>;
		/** The axis's scale state now: removing another column renumbers the axes. */
		scaleState: () => LinearScaleState | null;
		/** The axes' pixel extent (the chart's inner height). */
		pixelExtent: () => number;
		/** Where ParallelBrushes finds this column's handle to write the clause. */
		handles: Map<string, SourceHandle>;
	}

	// Keyed by column in the parent, so none of these change for an instance.
	const { filterGroup, column, chartId, excludeMarkIds, scaleState, pixelExtent, handles }: Props =
		$props();

	const columnRef = sqlColumn(column);

	const handle = filterGroup.register(`parallel-brush-${column}-${chartId}`, {
		excludeMarkIds,
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
		})
	});

	handles.set(column, handle);

	onDestroy(() => {
		handles.delete(column);
		handle.destroy();
	});
</script>
