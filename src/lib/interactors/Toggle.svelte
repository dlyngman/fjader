<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import { column, isIn, literal, or, and as sqlAnd, isNotDistinct } from '@uwdata/mosaic-sql';
	import type { ChartContext } from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { FilterGroup, ToggleState } from '$lib/query-engine/FilterGroup.svelte';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';

	interface Props {
		/** @deprecated No longer used — FilterGroup is obtained from context. */
		selection?: string;
		field: string | string[];
	}

	let { field }: Props = $props();

	const filterGroup = getContext<FilterGroup>('filter-group');
	const chart = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Normalize field to array for multi-column support
	const fields = Array.isArray(field) ? field : [field];
	const columnRefs = fields.map((f) => column(f));

	// Key helpers — identity for single field, JSON for multi
	const toKey = fields.length === 1 ? (tuple: unknown[]) => tuple[0] : (tuple: unknown[]) => JSON.stringify(tuple);
	const fromKey = fields.length === 1 ? (key: unknown) => [key] : (key: unknown) => JSON.parse(key as string);

	// Getter for scale states — resolved lazily since scales may not be ready at init
	function getToggleScaleStates() {
		const yIsBand = chart.scaleTypes?.y === 'band';
		const xIsBand = chart.scaleTypes?.x === 'band';
		const band = yIsBand ? chart.yScaleState : xIsBand ? chart.xScaleState : null;
		const color = scaleRegistry?.getScaleByField(fields[0], 'color');
		return [band, color].filter(Boolean) as {
			setActiveValues(values: Set<unknown>): void;
			clearActiveValues(): void;
		}[];
	}

	// Shared toggle state — deduplicated by field across Toggle + Legend
	const toggleState: ToggleState = filterGroup.getOrCreateToggle(fields[0]);

	// Build predicate from current toggle values and sync to FilterGroup + scales
	function syncFilter() {
		const values = toggleState.values;
		const scales = getToggleScaleStates();

		if (values.size === 0) {
			filterGroup.syncToggle(fields[0], null, null, () => new Set<string>());
			for (const s of scales) s.clearActiveValues();
			return;
		}

		const tuples = Array.from(values).map(fromKey);
		let predicate;
		if (fields.length === 1) {
			predicate = isIn(columnRefs[0], tuples.map((t) => literal(t[0])));
		} else {
			const clauses = tuples.map((t) =>
				sqlAnd(t.map((v: unknown, i: number) => isNotDistinct(columnRefs[i], literal(v))))
			);
			predicate = clauses.length === 1 ? clauses[0] : or(clauses);
		}

		filterGroup.syncToggle(
			fields[0],
			predicate,
			tuples,
			() => new Set<string>()
		);
		for (const s of scales) s.setActiveValues(values);
	}

	function toggle(tuple: unknown[], event: MouseEvent) {
		const isMulti = event.shiftKey || event.metaKey;
		const key = toKey(tuple);
		toggleState.toggle(key, isMulti);
		syncFilter();
	}

	chart.onChartClick = (event) => {
		const tm = chart.tooltipManager;
		const point = { x: event.offsetX, y: event.offsetY };
		const { xInBounds, yInBounds, innerPoint } = chart.getActiveAxes(point);

		// Path 1: Inner area click — use tooltip hit data (don't require visible —
		// pointer micro-movement during click hides tooltip but data stays valid)
		if (xInBounds && yInBounds && tm?.currentPoint) {
			const tuple = fields.map((f) => tm.currentPoint[f]);
			if (tuple.some((v) => v == null)) return;
			toggle(tuple, event);
			return;
		}

		// Path 2: Band axis margin click — invert position to find category
		if (!xInBounds && yInBounds && chart.scaleTypes?.y === 'band') {
			const bandState = chart.yScaleState as BandScaleState;
			const index = bandState.invertScreenToData(innerPoint.y, chart.innerHeight, true);
			const category = bandState.effectiveDomain[index] ?? null;
			if (category != null) {
				toggle([category], event);
				return;
			}
		}
		if (xInBounds && !yInBounds && chart.scaleTypes?.x === 'band') {
			const bandState = chart.xScaleState as BandScaleState;
			const index = bandState.invertScreenToData(innerPoint.x, chart.innerWidth, false);
			const category = bandState.effectiveDomain[index] ?? null;
			if (category != null) {
				toggle([category], event);
				return;
			}
		}

		// Path 3: Click on empty space — clear
		if (toggleState.active) {
			toggleState.clear();
			syncFilter();
		}
	};

	onDestroy(() => {
		// Clear filter and scale projection
		toggleState.clear();
		syncFilter();
		chart.onChartClick = null;
	});
</script>
