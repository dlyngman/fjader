<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import { clausePoints } from '@uwdata/mosaic-core';
	import { column } from '@uwdata/mosaic-sql';
	import type { ChartContext } from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { FilterBridge } from '$lib/selection/filter-bridge.svelte';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { ClauseSource } from '@uwdata/mosaic-core';

	interface Props {
		bridge: FilterBridge;
		field: string | string[];
	}

	let { bridge, field }: Props = $props();

	const chart = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Normalize field to array for multi-column support
	const fields = Array.isArray(field) ? field : [field];
	const columnRefs = fields.map((f) => column(f));

	// Key helpers — identity for single field, JSON for multi
	const toKey = fields.length === 1 ? (tuple) => tuple[0] : (tuple) => JSON.stringify(tuple);
	const fromKey = fields.length === 1 ? (key) => [key] : (key) => JSON.parse(key);

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

	// Shared toggle Selection — deduplicated by column across Toggle + Legend
	const {
		sel: selection,
		source,
		off: unregister
	} = bridge.createToggle(fields[0], {
		scaleStates: getToggleScaleStates
	});

	// Derive selected set reactively from scale state (projected by FilterBridge)
	const selectedSet = $derived.by(() => {
		const scales = getToggleScaleStates();
		for (const s of scales) {
			if (s && 'activeValues' in s) {
				const av = (s as BandScaleState).activeValues;
				if (av != null) return av;
			}
		}
		return null;
	});

	function toggle(tuple: unknown[], event: MouseEvent) {
		if (!selection) return;

		const isMulti = event.shiftKey || event.metaKey;
		const key = toKey(tuple);
		let newValues;

		if (isMulti && selectedSet) {
			const next = new Set(selectedSet);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			newValues = next.size === 0 ? null : Array.from(next).map(fromKey);
		} else if (selectedSet?.size === 1 && selectedSet.has(key)) {
			newValues = null;
		} else {
			newValues = [tuple];
		}

		if (newValues === null) {
			bridge.clearToggle(fields[0]);
		} else {
			selection.update(
				clausePoints(columnRefs, newValues, { source: source as unknown as ClauseSource })
			);
		}
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
		if (selectedSet) {
			bridge.clearToggle(fields[0]);
		}
	};

	onDestroy(() => {
		unregister();
		chart.onChartClick = null;
	});
</script>
