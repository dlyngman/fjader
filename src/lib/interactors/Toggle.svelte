<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { ActiveValueScale, ToggleHandle } from '$lib/query-engine/FilterGroup.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';

	/**
	 * Click-to-filter interactor for categorical fields.
	 *
	 * Two click surfaces, each toggling its own field:
	 * - Inner area (a mark): toggles the declared `field` using the hit row.
	 * - Band axis label: toggles the axis's own source field, whatever the
	 *   declared field is. Labels are a ready-made category picker.
	 *
	 * Toggles on different fields AND together. The source chart is excluded
	 * from its own toggles (crossfilter semantics) and dims instead via scale
	 * active-value projection; other charts in the filter group filter.
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
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Normalize field to array for multi-column support
	const fields = Array.isArray(field) ? field : [field];

	/** Marks in this chart — excluded so the source dims rather than filters. */
	const excludeMarkIds = () => new Set(chart.config.entries.keys());

	/** Scales keyed by the toggled field: its color scale and any band scale
	 *  whose source column is that field. Never a band scale for another field. */
	function scalesFor(toggleField: string): ActiveValueScale[] {
		const out: ActiveValueScale[] = [];
		const color = scaleRegistry?.getScaleByField(toggleField, 'color');
		if (color) out.push(color as unknown as ActiveValueScale);
		for (const axis of ['x', 'y'] as const) {
			if (chart.scaleTypes?.[axis] !== 'band') continue;
			const band = chart[`${axis}ScaleState`] as BandScaleState | null | undefined;
			if (band && band.sourceField === toggleField) out.push(band as unknown as ActiveValueScale);
		}
		return out;
	}

	function registerOn(toggleFields: string[]): ToggleHandle {
		return filterGroup.getOrCreateToggle(toggleFields).register({
			excludeMarkIds,
			scaleStates: () => (toggleFields.length === 1 ? scalesFor(toggleFields[0]) : [])
		});
	}

	const declaredState = filterGroup.getOrCreateToggle(fields);
	const declared = registerOn(fields);

	/**
	 * One registration per band axis field, for label clicks. Kept in step with
	 * the chart's band scales on every hover and click rather than on the first
	 * label click, so the field activates before it is clicked and follows a
	 * band channel reassigned at runtime.
	 */
	const bandHandles = new Map<string, ToggleHandle>();

	function bandFields(): Set<string> {
		const out = new Set<string>();
		for (const axis of ['x', 'y'] as const) {
			if (chart.scaleTypes?.[axis] !== 'band') continue;
			const band = chart[`${axis}ScaleState`] as BandScaleState | null | undefined;
			// The declared field already has its registration.
			if (band?.sourceField && !(fields.length === 1 && band.sourceField === fields[0])) {
				out.add(band.sourceField);
			}
		}
		return out;
	}

	function syncBandRegistrations() {
		const wanted = bandFields();
		for (const [bandField, handle] of bandHandles) {
			if (wanted.has(bandField)) continue;
			handle.destroy();
			bandHandles.delete(bandField);
		}
		for (const bandField of wanted) {
			if (!bandHandles.has(bandField)) bandHandles.set(bandField, registerOn([bandField]));
		}
	}

	function handleFor(toggleField: string): ToggleHandle | null {
		if (fields.length === 1 && toggleField === fields[0]) return declared;
		syncBandRegistrations();
		return bandHandles.get(toggleField) ?? null;
	}

	function activate() {
		syncBandRegistrations();
		declared.activate();
		for (const handle of bandHandles.values()) handle.activate();
	}
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
			handleFor(hit.field)?.toggle([hit.value], isMulti);
			return;
		}

		// Path 3: Click on empty space — clear everything this interactor owns
		clearAll();
	};

	function clearAll() {
		if (declaredState.active) declared.clear();
		for (const [bandField, handle] of bandHandles) {
			if (filterGroup.getOrCreateToggle(bandField).active) handle.clear();
		}
	}

	onDestroy(() => {
		clearAll();
		declared.destroy();
		for (const handle of bandHandles.values()) handle.destroy();
		chart.activators.delete(activate);
		chart.onChartClick = null;
	});
</script>
