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
	const source = `toggle-${chart.chartId}`;

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

	// Register with FilterBridge, passing lazy getter for scale state refs
	const { sel: selection, off: unregister } = bridge.createLocal('single', {
		source,
		scaleStates: getToggleScaleStates,
		augment: (clause) => ({
			kind: 'toggle',
			column: fields[0],
			fields,
			label: fields.join(', '),
			values: clause?.value?.map(toKey) ?? []
		})
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

		selection.update(clausePoints(columnRefs, newValues, { source }));
	}

	// Click callback — reads tooltip hit detection result (only when visible,
	// since currentPoint persists during fade-out for tooltip display)
	chart.onChartClick = (event) => {
		const tm = chart.tooltipManager;
		if (!tm?.visible || !tm.currentPoint) {
			if (selectedSet) {
				bridge.clearByColumn(fields[0]);
			}
			return;
		}
		const tuple = fields.map((f) => tm.currentPoint[f]);
		if (tuple.some((v) => v == null)) return;
		toggle(tuple, event);
	};

	onDestroy(() => {
		unregister();
		chart.onChartClick = null;
	});
</script>
