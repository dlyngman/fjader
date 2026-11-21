<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { and, isBetween } from '@uwdata/mosaic-sql';
	import {
		DECLARATION_SCOPE,
		declareOverlay,
		getDeclarationChart,
		type DeclarationScopeContext
	} from '$lib/components/charts/declarations.svelte';
	import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { FieldRef } from '$lib/types';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import { buildColumnRef } from './brush-utils';
	import { CellPixels, IntervalDrag2D, type IntervalShared } from './interval-drag.svelte';
	import Interval2DCell from './Interval2DCell.svelte';

	/**
	 * A two-axis brush: drag in the plot to select a rectangle.
	 *
	 * A declaration, split as Interval1D is: this registers once for the chart
	 * and holds the rectangle in data space and its clause; each cell
	 * (Interval2DCell) drives the drag through its own scales and draws it. In a
	 * facet grid it is one selection, drawn in every cell.
	 */
	interface Props {
		selection?: string;
		xField?: FieldRef;
		yField?: FieldRef;
	}

	let { selection, xField, yField }: Props = $props();

	const chart = getDeclarationChart('Interval2D');
	const filterGroup = getContext<FilterGroupRegistry>('filter-groups').get(
		untrack(() => selection)
	);

	const resolvedXField = $derived(xField ?? chart.xColumnName ?? chart.xLabel);
	const resolvedYField = $derived(yField ?? chart.yColumnName ?? chart.yLabel);
	const xColumnRef = $derived(
		buildColumnRef(resolvedXField, chart.xScaleState as { t0?: Date } | null)
	);
	const yColumnRef = $derived(
		buildColumnRef(resolvedYField, chart.yScaleState as { t0?: Date } | null)
	);

	// Per chart; in a per-cell snippet, per cell (the id a cell's brush always had).
	const scope = getContext<DeclarationScopeContext | undefined>(DECLARATION_SCOPE);
	const source = `interval-2d-${scope?.cellId ?? chart.chartId}`;

	/** False once destroyed: a cell unmounting later (mid-drag) must not write. */
	let live = true;

	const drag = new IntervalDrag2D({
		range(x0, x1, y0, y1) {
			if (!live || !xColumnRef || !yColumnRef) return false;
			const predicate = and([isBetween(xColumnRef, [x0, x1]), isBetween(yColumnRef, [y0, y1])]);
			handle.update(predicate, [
				[x0, x1],
				[y0, y1]
			]);
			return true;
		},
		clear() {
			if (live) handle.clear();
		}
	});

	const pixels = new CellPixels();
	const linear = (state: unknown) => (state instanceof LinearScaleState ? state : null);

	const handle = filterGroup.register(source, {
		// Its own chart is not filtered by it (crossfilter).
		chart: chart.config,
		activeDims: () => {
			const x = linear(chart.xScaleState);
			const y = linear(chart.yScaleState);
			// No pixels before a cell activated it: nothing to bin by.
			if (!pixels.width || !x || !y || !xColumnRef || !yColumnRef) return [];
			// Where each axis's domain is heading (the spring target), so a table
			// built while it still moves fits the view it settles on.
			return [
				{
					kind: 'bin',
					columnRef: xColumnRef,
					domain: x.domain.target,
					pixelExtent: pixels.width,
					extent: x.effectiveExtent
				},
				{
					kind: 'bin',
					columnRef: yColumnRef,
					domain: y.domain.target,
					pixelExtent: pixels.height,
					extent: y.effectiveExtent
				}
			];
		},
		// Read on every query: the scale states' target buffers are reused, so this
		// allocates nothing. The targets, like activeDims, not the animated domains.
		view: (out) => {
			const x = linear(chart.xScaleState);
			const y = linear(chart.yScaleState);
			if (!x || !y) return;
			const xDomain = x.domain.targetBuffer;
			out[0] = xDomain[0];
			out[1] = xDomain[1];
			out[2] = pixels.width;
			const yDomain = y.domain.targetBuffer;
			out[3] = yDomain[0];
			out[4] = yDomain[1];
			out[5] = pixels.height;
		},
		augment: (value) => ({
			kind: 'range',
			label: `${typeof resolvedXField === 'string' ? resolvedXField : resolvedXField?.toString()} × ${typeof resolvedYField === 'string' ? resolvedYField : resolvedYField?.toString()}`,
			xColumn: resolvedXField,
			yColumn: resolvedYField,
			xValues: (value as unknown[][])?.[0],
			yValues: (value as unknown[][])?.[1]
		}),
		// The clause was removed from outside (clearAll, a filter pill): take the
		// rectangle down too, which only this control holds.
		onCleared: () => {
			if (drag.brush.active) drag.clear();
		}
	});

	const shared: IntervalShared<IntervalDrag2D> = {
		drag,
		pixels,
		activate: () => {
			if (live) handle.activate();
		}
	};

	// Clear the brush when a shared scale's domain no longer holds it.
	$effect(() => {
		drag.validate(
			linear(chart.xScaleState)?.domain.current ?? null,
			linear(chart.yScaleState)?.domain.current ?? null
		);
	});

	onDestroy(() => {
		live = false;
		handle.destroy();
	});

	declareOverlay(cell, { slot: 'interactors' });
</script>

{#snippet cell()}
	<Interval2DCell {shared} />
{/snippet}
