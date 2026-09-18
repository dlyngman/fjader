<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import { column, isIn, literal, or, and as sqlAnd, isNotDistinct } from '@uwdata/mosaic-sql';
	import type { ChartContext } from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { ActiveValueScale, ToggleState } from '$lib/query-engine/FilterGroup.svelte';
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

	/** One toggle per field key this interactor drives: the declared field
	 *  (or tuple) plus, lazily, the band axis field for label clicks. */
	interface OwnedToggle {
		fields: string[];
		columnRefs: ReturnType<typeof column>[];
		state: ToggleState;
		toKey: (tuple: unknown[]) => unknown;
		fromKey: (key: unknown) => unknown[];
	}
	const owned = new Map<string, OwnedToggle>();

	function getToggle(toggleFields: string[]): OwnedToggle {
		const id = toggleFields.join(' ');
		let t = owned.get(id);
		if (!t) {
			const single = toggleFields.length === 1;
			t = {
				fields: toggleFields,
				columnRefs: toggleFields.map((f) => column(f)),
				state: filterGroup.getOrCreateToggle(toggleFields[0]),
				toKey: single ? (tuple) => tuple[0] : (tuple) => JSON.stringify(tuple),
				fromKey: single ? (key) => [key] : (key) => JSON.parse(key as string)
			};
			owned.set(id, t);
		}
		return t;
	}

	const declared = getToggle(fields);

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

	function syncFilter(t: OwnedToggle) {
		const values = t.state.values;
		const single = t.fields.length === 1;
		const opts = {
			excludeMarkIds,
			// Projection only makes sense for single-field toggles.
			...(single && {
				scaleStates: () => scalesFor(t.fields[0]),
				projectionValues: () => (t.state.values.size ? new Set(t.state.values) : null)
			})
		};

		if (values.size === 0) {
			filterGroup.syncToggle(t.fields[0], null, null, opts);
			return;
		}

		const tuples = Array.from(values).map(t.fromKey);
		let predicate;
		if (single) {
			predicate = isIn(
				t.columnRefs[0],
				tuples.map((tuple) => literal(tuple[0]))
			);
		} else {
			const clauses = tuples.map((tuple) =>
				sqlAnd(tuple.map((v: unknown, i: number) => isNotDistinct(t.columnRefs[i], literal(v))))
			);
			predicate = clauses.length === 1 ? clauses[0] : or(clauses);
		}

		filterGroup.syncToggle(t.fields[0], predicate, tuples, opts);
	}

	function toggle(t: OwnedToggle, tuple: unknown[], event: MouseEvent) {
		const isMulti = event.shiftKey || event.metaKey;
		t.state.toggle(t.toKey(tuple), isMulti);
		syncFilter(t);
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

		// Path 1: Inner area click — use tooltip hit data (don't require visible —
		// pointer micro-movement during click hides tooltip but data stays valid)
		if (xInBounds && yInBounds && tm?.currentPoint) {
			const tuple = fields.map((f) => tm.currentPoint![f]);
			if (tuple.some((v) => v == null)) return;
			toggle(declared, tuple, event);
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
			toggle(getToggle([hit.field]), [hit.value], event);
			return;
		}

		// Path 3: Click on empty space — clear everything this interactor owns
		clearAll();
	};

	function clearAll() {
		for (const t of owned.values()) {
			if (!t.state.active) continue;
			t.state.clear();
			syncFilter(t);
		}
	}

	onDestroy(() => {
		clearAll();
		chart.onChartClick = null;
	});
</script>
