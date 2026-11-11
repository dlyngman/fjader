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
	 * Toggles on different fields AND together. The chart skips its own toggles
	 * (crossfilter): its marks that read the toggled field dim, the rest keep
	 * their data. Elsewhere in the group, marks that read the field dim and the
	 * rest filter.
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

	/**
	 * This chart skips its own toggles (crossfilter): its marks keyed by the
	 * toggled field dim, the rest keep their data.
	 */
	const skips = chart.config;

	const declared = filterGroup.registerToggle(fields, { chart: skips });
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
	): { field: string; value: unknown; otherId: number | null } | null {
		if (chart.scaleTypes?.[axis] !== 'band') return null;
		const bandState = chart[`${axis}ScaleState`] as BandScaleState;
		const extent = axis === 'x' ? chart.innerWidth : chart.innerHeight;
		const slot = bandState.invertScreenToData(innerPos, extent, axis === 'y');
		if (slot == null) return null;
		const id = bandState.idAtSlot(slot);
		// undefined is "no category here"; null is the NULL category, a real one.
		const value = id == null ? undefined : bandState.categoryAt(id);
		if (value === undefined) return null;
		// The axis's Other bucket: its label is no value, so the click selects
		// what it holds instead.
		const otherId = id != null && id === bandState.otherId ? id : null;
		return { field: bandState.sourceField, value, otherId };
	}

	/**
	 * The Other bucket an inner click hit, or null: the hit row's band id on an
	 * axis of the declared field, when it is that axis's Other. The label in
	 * the row can't say, so the tooltip keeps the raw id beside it.
	 */
	function otherHit(point: Record<string, unknown>): number | null {
		if (!declaredField) return null;
		for (const axis of ['x', 'y'] as const) {
			if (chart.scaleTypes?.[axis] !== 'band') continue;
			const bandState = chart[`${axis}ScaleState`] as BandScaleState;
			if (bandState.sourceField !== declaredField) continue;
			const id = point[axis === 'x' ? '__bandIdX' : '__bandIdY'];
			if (typeof id === 'number' && id === bandState.otherId) return id;
		}
		return null;
	}

	chart.onChartClick = (event) => {
		const tm = chart.tooltipManager;
		const point = { x: event.offsetX, y: event.offsetY };
		const { xInBounds, yInBounds, innerPoint } = chart.getActiveAxes(point);
		const isMulti = event.shiftKey || event.metaKey;

		// Path 1: Inner area click — use tooltip hit data (don't require visible —
		// pointer micro-movement during click hides tooltip but data stays valid)
		if (xInBounds && yInBounds && tm?.currentPoint) {
			const otherId = otherHit(tm.currentPoint);
			if (otherId !== null) {
				const facetId = tm.currentPoint.__facetId;
				declared.toggleOther(otherId, typeof facetId === 'number' ? facetId : null, isMulti);
				return;
			}
			const tuple = fields.map((f) => tm.currentPoint![f]);
			// A missing field is undefined; null is the NULL category, selectable.
			if (tuple.some((v) => v === undefined)) return;
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
			const toggle = toggleFor(hit.field);
			if (hit.otherId !== null) toggle?.toggleOther(hit.otherId, null, isMulti);
			else toggle?.toggle([hit.value], isMulti);
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
	<BandLabelToggle {filterGroup} field={bandField} chart={skips} handles={bandToggles} />
{/each}
