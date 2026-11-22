<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { isBetween } from '@uwdata/mosaic-sql';
	import { declareOverlay, getDeclarationChart } from '$lib/components/charts/declarations.svelte';
	import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { FieldRef } from '$lib/types';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import { buildColumnRef } from './brush-utils';
	import { CellPixels, IntervalDrag1D, type IntervalShared } from './interval-drag.svelte';
	import Interval1DCell from './Interval1DCell.svelte';

	/**
	 * A one-axis brush: drag in the plot to select a range on x or y.
	 *
	 * A declaration, split by responsibility: this registers the brush once for
	 * the chart and holds its range in data space, its clause and what follows
	 * the shared scale (validation, a linked chart's pan); each cell
	 * (Interval1DCell) turns its pointer events into the drag through its own
	 * scale and draws the range. In a facet grid it is one selection: a drag in
	 * any cell replaces it, and every cell draws it.
	 */
	interface Props {
		/** Filter group name: which selection this brush writes to. */
		selection?: string;
		/**
		 * The column it selects on. Default: the first column the chart's marks
		 * draw on this axis; on a range, its start (x1 or y1), so ranges are
		 * selected by where they start. A mark drawing another column on the
		 * same axis is not selected by what lies under the brush: name its
		 * column here.
		 */
		field?: FieldRef;
		axis?: 'x' | 'y';
	}

	let { selection, field, axis = 'x' }: Props = $props();

	const chart = getDeclarationChart('Interval1D');
	const filterGroup = getContext<FilterGroupRegistry>('filter-groups').get(
		untrack(() => selection)
	);
	const isX = untrack(() => axis) === 'x';

	const scaleState = $derived(isX ? chart.xScaleState : chart.yScaleState);
	const resolvedField = $derived(
		field ?? (isX ? chart.xColumnName : chart.yColumnName) ?? (isX ? chart.xLabel : chart.yLabel)
	);
	const columnRef = $derived.by(() =>
		buildColumnRef(
			resolvedField,
			scaleState && 't0' in scaleState ? (scaleState as { t0?: Date | null }) : null
		)
	);

	const source = `interval-${isX ? 'x' : 'y'}-${chart.chartId}`;

	/** False once destroyed: a cell unmounting later (mid-drag) must not write. */
	let live = true;

	const drag = new IntervalDrag1D({
		range(min, max) {
			if (!live) return false;
			// The extent drives linked charts' domains even with no column to filter
			// (setSelectionExtent skips an unchanged one).
			if (scaleState instanceof LinearScaleState) scaleState.setSelectionExtent(min, max, 'brush');
			return write(min, max);
		},
		clear() {
			if (!live) return;
			if (scaleState instanceof LinearScaleState) scaleState.clearSelectionExtent();
			handle.clear();
		}
	});

	const pixels = new CellPixels();
	/** The pixels the brush spans (CellPixels): 0 before a cell activated it. */
	const pixelExtent = () => (isX ? pixels.width : pixels.height);

	const handle = filterGroup.register(source, {
		// Its own chart is not filtered by it (crossfilter).
		chart: chart.config,
		activeDims: () => {
			const extent = pixelExtent();
			if (!columnRef || !extent || !(scaleState instanceof LinearScaleState)) return [];
			return [
				{
					kind: 'bin',
					columnRef,
					// Where the spring is heading, so a table built while it is still
					// moving fits the view it settles on.
					domain: scaleState.domain.target,
					pixelExtent: extent,
					// For the size guard: how many bins the data spans at this zoom.
					extent: scaleState.effectiveExtent
				}
			];
		},
		// Read on every query: the scale state's target buffer is reused, so this
		// allocates nothing. The target, like activeDims, not the animated domain.
		view: (out) => {
			if (!(scaleState instanceof LinearScaleState)) return;
			const domain = scaleState.domain.targetBuffer;
			out[0] = domain[0];
			out[1] = domain[1];
			out[2] = pixelExtent();
		},
		augment: (value) => ({
			kind: 'range',
			column: typeof resolvedField === 'string' ? resolvedField : (resolvedField?.toString() ?? ''),
			label: typeof resolvedField === 'string' ? resolvedField : resolvedField?.toString(),
			values: value ? [(value as number[])[0], (value as number[])[1]] : []
		}),
		// The clause was removed from outside (clearAll, a filter pill): take the
		// rectangle down too, which only this control holds.
		onCleared: () => {
			if (drag.brush.active) drag.clear();
		}
	});

	const shared: IntervalShared<IntervalDrag1D> = {
		drag,
		pixels,
		activate: () => {
			if (live) handle.activate();
		}
	};

	/** Write the clause; false while the column is unknown. */
	function write(min: number, max: number): boolean {
		if (!columnRef) return false;
		handle.update(isBetween(columnRef, [min, max]), [min, max]);
		return true;
	}

	// The scale this brush writes, for the charts following it (useXSelection):
	// again when the chart's scale, label or column changes.
	$effect(() => chart.registerBrushTarget(isX ? 'x' : 'y'));

	// Clear the brush when the shared scale's domain no longer holds it.
	$effect(() => {
		if (scaleState instanceof LinearScaleState) drag.validate(scaleState.domain.current);
	});

	// A linked chart's pan or zoom (selectionSource 'external'): follow it and
	// write the clause, or clear when it clears. Tracks only the extent and its
	// source; the rest runs untracked: writing the clause reads state it then
	// writes (the selection, the scales' active values), which made this re-run
	// itself without end while a detail chart was panned.
	$effect(() => {
		if (!(scaleState instanceof LinearScaleState)) return;
		const extent = scaleState.selectionExtent;
		const from = scaleState.selectionSource;
		untrack(() => {
			if (extent && from === 'external') {
				drag.setExternal(extent[0], extent[1]);
				write(extent[0], extent[1]);
			} else if (!extent && drag.brush.active) {
				drag.clear();
			}
		});
	});

	onDestroy(() => {
		live = false;
		handle.destroy();
	});

	declareOverlay(cell, { slot: 'interactors' });
</script>

{#snippet cell()}
	<Interval1DCell {shared} axis={isX ? 'x' : 'y'} />
{/snippet}
