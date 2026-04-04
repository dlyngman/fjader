<script lang="ts">
	/**
	 * DerivedInterval1D — reads a brush from a source FilterGroup, applies a
	 * calendar offset, and writes the shifted predicate to a target FilterGroup.
	 *
	 * Uses FilterGroupRegistry for named groups: sourceSelection → source group,
	 * selection → target group. Marks declare which group they belong to via
	 * their own `selection` prop.
	 */
	import { getContext, onMount } from 'svelte';
	import { isBetween, column as sqlColumn } from '@uwdata/mosaic-sql';
	import GhostBrushOverlay from './GhostBrushOverlay.svelte';
	import { buildColumnRef } from './brush-utils';
	import { parseOffset, applyOffset, formatOffsetLabel } from './calendar-offset';
	import type { ChartContext } from '$lib/types';
	import { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	interface Props {
		sourceSelection: string;
		selection?: string;
		offset: string;
		axis?: 'x' | 'y';
		relayClauses?: boolean;
	}

	let {
		sourceSelection,
		selection: selectionName = 'derived',
		offset,
		axis = 'x',
		relayClauses = true
	}: Props = $props();

	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const sourceGroup = filterGroups.get(sourceSelection);
	const targetGroup = filterGroups.get(selectionName);
	const chart = getContext<ChartContext>('chart');
	const isX = axis === 'x';
	const parsedOffset = parseOffset(offset);
	const label = formatOffsetLabel(offset);

	function getScale() {
		return isX ? chart.xScale : chart.yScale;
	}
	const scaleState = $derived(isX ? chart.xScaleState : chart.yScaleState);
	const resolvedField = $derived(
		(isX ? chart.xColumnName : chart.yColumnName) ?? (isX ? chart.xLabel : chart.yLabel)
	);

	// Source key for this derived interactor
	const sourceKey = `derived-${axis}-${chart.chartId}`;

	// Column reference for SQL predicate building
	const columnRef = $derived.by(() =>
		buildColumnRef(
			resolvedField,
			scaleState && 't0' in scaleState ? (scaleState as { t0?: Date | null }) : null
		)
	);

	// =========================================================================
	// Filter Bridge: Watch source group items → compute derived extent
	// =========================================================================

	// Extract primary range from source group's active filter items
	const primaryRange = $derived.by((): [number, number] | null => {
		const items = sourceGroup.items;
		const rangeItem = items.find((item) => item.schema?.kind === 'range');
		if (!rangeItem?.schema?.values?.length) return null;
		const values = rangeItem.schema.values as number[];
		return [values[0], values[1]];
	});

	// Compute derived extent via Temporal calendar offset
	const derivedExtent = $derived.by((): [number, number] | null => {
		if (!primaryRange || !scaleState) return null;
		if (!(scaleState instanceof TimeScaleState)) return null;
		if (!scaleState.t0) return null;

		const minDate = scaleState.offsetToDate(primaryRange[0]);
		const maxDate = scaleState.offsetToDate(primaryRange[1]);
		if (!minDate || !maxDate) return null;

		const derivedMin = applyOffset(minDate, parsedOffset);
		const derivedMax = applyOffset(maxDate, parsedOffset);
		const derivedMinOff = scaleState.dateToOffset(derivedMin);
		const derivedMaxOff = scaleState.dateToOffset(derivedMax);
		if (derivedMinOff == null || derivedMaxOff == null) return null;

		return [derivedMinOff, derivedMaxOff];
	});

	// Screen coordinates for rendering (clamped to chart bounds)
	const overlayScreen = $derived.by(() => {
		if (!derivedExtent) return null;
		const s = getScale();
		if (!s) return null;
		const p0 = s(Math.min(derivedExtent[0], derivedExtent[1]));
		const p1 = s(Math.max(derivedExtent[0], derivedExtent[1]));
		const dim = isX ? chart.innerWidth : chart.innerHeight;
		const cMin = Math.max(0, p0);
		const cMax = Math.min(dim, p1);
		return cMax > cMin ? { pos: cMin, size: cMax - cMin } : null;
	});

	// =========================================================================
	// Emit derived filter clause to target FilterGroup
	// =========================================================================

	let lastEmittedMin: number | null = null;
	let lastEmittedMax: number | null = null;

	$effect(() => {
		if (!derivedExtent) {
			// Clear derived filter when primary is cleared
			if (lastEmittedMin != null) {
				lastEmittedMin = null;
				lastEmittedMax = null;
				targetGroup.removeManual(sourceKey);
			}
			return;
		}

		const dataMin = Math.min(derivedExtent[0], derivedExtent[1]);
		const dataMax = Math.max(derivedExtent[0], derivedExtent[1]);

		// Skip if unchanged
		if (
			lastEmittedMin != null &&
			Math.abs(dataMin - lastEmittedMin) < 1e-10 &&
			Math.abs(dataMax - lastEmittedMax!) < 1e-10
		) {
			return;
		}

		lastEmittedMin = dataMin;
		lastEmittedMax = dataMax;

		if (!columnRef) return;

		const fieldStr =
			typeof resolvedField === 'string' ? resolvedField : (resolvedField?.toString() ?? '');

		targetGroup.upsertManual(
			sourceKey,
			isBetween(columnRef, [dataMin, dataMax]),
			[dataMin, dataMax],
			new Set<string>(), // No excludeMarkIds — target group only has comparison marks
			{
				kind: 'range',
				column: fieldStr,
				label: fieldStr,
				values: [dataMin, dataMax]
			}
		);
	});

	// =========================================================================
	// Relay non-axis clauses from source → target
	// =========================================================================

	let relayedKeys = new Set<string>();

	$effect(() => {
		if (!relayClauses) {
			for (const key of relayedKeys) targetGroup.removeManual(key);
			relayedKeys = new Set();
			return;
		}

		const items = sourceGroup.items;
		const fieldStr =
			typeof resolvedField === 'string' ? resolvedField : (resolvedField?.toString() ?? '');

		const currentKeys = new Set<string>();
		for (const item of items) {
			// Skip the range clause on the axis column — we replace it with the shifted version
			if (item.schema?.kind === 'range' && item.schema?.column === fieldStr) continue;

			if (item.predicate) {
				const key = `relay:${item.sourceId}`;
				currentKeys.add(key);
				targetGroup.upsertManual(
					key,
					item.predicate,
					item.value,
					new Set<string>(),
					item.schema ?? undefined
				);
			}
		}

		// Remove stale relayed clauses
		for (const key of relayedKeys) {
			if (!currentKeys.has(key)) targetGroup.removeManual(key);
		}
		relayedKeys = currentKeys;
	});

	onMount(() => {
		return () => {
			targetGroup.removeManual(sourceKey);
			for (const key of relayedKeys) targetGroup.removeManual(key);
			relayedKeys = new Set();
		};
	});
</script>

{#if overlayScreen}
	<GhostBrushOverlay
		x={isX ? overlayScreen.pos : 0}
		y={isX ? 0 : overlayScreen.pos}
		width={isX ? overlayScreen.size : chart.innerWidth}
		height={isX ? chart.innerHeight : overlayScreen.size}
		{label}
	/>
{/if}
