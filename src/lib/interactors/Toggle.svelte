<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { ToggleHandle } from '$lib/query-engine/FilterGroup.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import BandLabelToggle from './BandLabelToggle.svelte';
	import { bandFieldsOf } from './band-fields';

	/**
	 * Click-to-filter interactor for categorical fields.
	 *
	 * Two click surfaces, each toggling its own field:
	 * - Inner area (a mark): toggles the declared `field` using the hit row.
	 * - Band axis label: toggles the axis's own source field, whatever the
	 *   declared field is. Labels are a ready-made category picker.
	 *
	 * Toggles on different fields AND together. The source chart is excluded
	 * from its own toggles (crossfilter semantics) and dims instead, through its
	 * filter group's selection on the field; other charts in the group filter.
	 */

	interface Props {
		/** Filter group name — selects which FilterGroup this toggle writes to. */
		selection?: string;
		field: string | string[];
	}

	let { selection, field }: Props = $props();

	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const filterGroup = filterGroups.get(selection);
	const chart = getContext<ChartContext>('chart');

	// Normalize field to array for multi-column support
	const fields = Array.isArray(field) ? field : [field];
	const declaredField = fields.length === 1 ? fields[0] : null;

	/** Marks in this chart — excluded so the source dims rather than filters. */
	const excludeMarkIds = () => new Set(chart.config.entries.keys());

	const declared = filterGroup.registerToggle(fields, { excludeMarkIds });
	chart.activators.add(declared.activate);

	/** One BandLabelToggle per band axis field (see bandFieldsOf). */
	const bandFields = $derived(bandFieldsOf([chart.xScaleState, chart.yScaleState], declaredField));

	/** Band label toggles, filled by the BandLabelToggle children for clicks. */
	const bandToggles = new Map<string, ToggleHandle>();

	function toggleFor(toggleField: string): ToggleHandle | null {
		return toggleField === declaredField ? declared : (bandToggles.get(toggleField) ?? null);
	}

	/**
	 * Band axis click → category under the pointer on that axis, or null.
	 *
	 * Decoded through the scale rather than by indexing its domain. The two
	 * agree — the domain IS in display order, so `effectiveDomain[slot]` is the
	 * category at that slot — but the equivalence is a property of the scale's
	 * internals, and re-deriving it here is how a consumer came to compare a
	 * slot against an id in the first place. `idAtSlot` and `categoryAt` are the
	 * pair that owns the crossing, and they handle the no-identity case that
	 * indexing by hand does not.
	 */
	function bandCategoryAt(
		axis: 'x' | 'y',
		innerPos: number
	): { field: string; value: unknown } | null {
		if (chart.scaleTypes?.[axis] !== 'band') return null;
		const bandState = chart[`${axis}ScaleState`] as BandScaleState;
		const extent = axis === 'x' ? chart.innerWidth : chart.innerHeight;
		const slot = bandState.invertScreenToData(innerPos, extent, axis === 'y');
		if (slot == null) return null;
		const id = bandState.idAtSlot(slot);
		const value = id == null ? null : (bandState.categoryAt(id) ?? null);
		return value == null ? null : { field: bandState.sourceField, value };
	}

	chart.onChartClick = (event) => {
		const tm = chart.tooltipManager;
		const point = { x: event.offsetX, y: event.offsetY };
		const { xInBounds, yInBounds, innerPoint } = chart.getActiveAxes(point);
		const isMulti = event.shiftKey || event.metaKey;

		// Path 1: Inner area click — use tooltip hit data (don't require visible —
		// pointer micro-movement during click hides tooltip but data stays valid)
		if (xInBounds && yInBounds && tm?.currentPoint) {
			const tuple = fields.map((f) => tm.currentPoint![f]);
			if (tuple.some((v) => v == null)) return;
			declared.toggle(tuple, isMulti);
			return;
		}

		// Path 2: Band axis margin click — toggle the axis's own field
		const hit =
			!xInBounds && yInBounds
				? bandCategoryAt('y', innerPoint.y)
				: xInBounds && !yInBounds
					? bandCategoryAt('x', innerPoint.x)
					: null;
		if (hit) {
			toggleFor(hit.field)?.toggle([hit.value], isMulti);
			return;
		}

		// Path 3: Click on empty space — clear everything this interactor owns
		if (declared.active) declared.clear();
		for (const toggle of bandToggles.values()) if (toggle.active) toggle.clear();
	};

	// Destroying the declared registration clears its selection when it was the
	// last control for it; a selection a legend still shows stays. The band
	// label children destroy their own.
	onDestroy(() => {
		declared.destroy();
		chart.activators.delete(declared.activate);
		chart.onChartClick = null;
	});
</script>

{#each bandFields as bandField (bandField)}
	<BandLabelToggle {filterGroup} field={bandField} {excludeMarkIds} handles={bandToggles} />
{/each}
