<script lang="ts">
	/**
	 * A Toggle in one cell: calls the toggle's activators when the cell is
	 * hovered, and turns the cell's clicks into toggles, on the registrations
	 * the Toggle declaration made once for the chart (ToggleShared). What needs
	 * the cell stays here: its hover point, axes, inner size and tooltip hit.
	 */
	import { getContext, onDestroy } from 'svelte';
	import { isMultiSelect } from '$lib/interactors/modifiers';
	import type { ChartContext } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { ToggleShared } from './toggle-shared';

	interface Props {
		shared: ToggleShared;
	}

	const { shared }: Props = $props();
	const chart = getContext<ChartContext>('chart');
	const { fields, declaredField, declared } = shared;

	/** One activator for the cell: every registration's, read on each call. */
	const activate = () => {
		for (const a of shared.activators) a();
	};
	chart.activators.add(activate);

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

	const onClick: NonNullable<ChartContext['onChartClick']> = (event, point) => {
		const tm = chart.tooltipManager;
		const { xInBounds, yInBounds, innerPoint } = chart.getActiveAxes(point);
		const isMulti = isMultiSelect(event);

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
			const toggle = shared.toggleFor(hit.field);
			if (hit.otherId !== null) toggle?.toggleOther(hit.otherId, null, isMulti);
			else toggle?.toggle([hit.value], isMulti);
			return;
		}

		// Path 3: Click on empty space — clear everything this interactor owns
		if (declared.active) declared.clear();
		for (const toggle of shared.bandToggles.values()) if (toggle.active) toggle.clear();
	};

	chart.onChartClick = onClick;

	onDestroy(() => {
		chart.activators.delete(activate);
		// Only if still this cell's toggle: another may have taken the hook since.
		if (chart.onChartClick === onClick) chart.onChartClick = null;
	});
</script>
