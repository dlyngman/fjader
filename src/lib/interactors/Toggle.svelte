<script>
	import { getContext, onDestroy } from 'svelte';
	import { clausePoints } from '@uwdata/mosaic-core';
	import { column } from '@uwdata/mosaic-sql';

	let { bridge, field } = $props();

	const chart = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

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
		return [band, color].filter(Boolean);
	}

	// Shared toggle Selection — deduplicated by column across Toggle + Legend
	const { sel: selection, source, off: unregister } = bridge.createToggle(fields[0], {
		scaleStates: getToggleScaleStates
	});

	// Derive selected set reactively from scale state (projected by FilterBridge)
	const selectedSet = $derived.by(() => {
		const scales = getToggleScaleStates();
		for (const s of scales) {
			if (s?.activeValues) return s.activeValues;
		}
		return null;
	});

	function toggle(tuple, event) {
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
			selection.update(clausePoints(columnRefs, newValues, { source }));
		}
	}

	// Resolve category from a click in the band axis margin area.
	// Uses the same getActiveAxes pattern as wheel/pan handlers in ChartContainer.
	function resolveMarginCategory(event) {
		const point = { x: event.offsetX, y: event.offsetY };
		const { xInBounds, yInBounds, innerPoint } = chart.getActiveAxes(point);

		// Y-axis margin: click left of inner area, Y within chart range
		if (!xInBounds && yInBounds && chart.scaleTypes?.y === 'band') {
			const index = chart.yScaleState.invertScreenToData(
				innerPoint.y, chart.innerHeight, true
			);
			return chart.yScaleState.effectiveDomain[index] ?? null;
		}

		// X-axis margin: click below inner area, X within chart range
		if (xInBounds && !yInBounds && chart.scaleTypes?.x === 'band') {
			const index = chart.xScaleState.invertScreenToData(
				innerPoint.x, chart.innerWidth, false
			);
			return chart.xScaleState.effectiveDomain[index] ?? null;
		}

		return null;
	}

	chart.onChartClick = (event) => {
		// Path 1: Inner area click — use tooltip hit data
		const tm = chart.tooltipManager;
		if (tm?.visible && tm.currentPoint) {
			const tuple = fields.map((f) => tm.currentPoint[f]);
			if (tuple.some((v) => v == null)) return;
			toggle(tuple, event);
			return;
		}

		// Path 2: Band axis margin click — invert position to find category
		const category = resolveMarginCategory(event);
		if (category != null) {
			toggle([category], event);
			return;
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
