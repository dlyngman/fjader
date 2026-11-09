<script lang="ts">
	/**
	 * DerivedInterval1D — reads a brush from a source FilterGroup, applies a
	 * calendar offset, and writes the shifted predicate to a target FilterGroup.
	 *
	 * Uses FilterGroupRegistry for named groups: sourceSelection → source group,
	 * selection → target group. Marks declare which group they belong to via
	 * their own `selection` prop.
	 */
	import { getContext, onMount, untrack } from 'svelte';
	import { isBetween, column as sqlColumn } from '@uwdata/mosaic-sql';
	import GhostBrushOverlay from './GhostBrushOverlay.svelte';
	import { buildColumnRef } from './brush-utils';
	import { parseOffset, applyOffset, formatOffsetLabel } from './calendar-offset';
	import type { ChartContext } from '$lib/types';
	import { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import type { Clause } from '$lib/query-engine/CrossfilterSelection.svelte';
	import { ClauseRelay } from './relay-clauses';

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

	// The primary range: the source group's first range clause, found by the
	// schema its brush stored when writing it.
	const primaryRange = $derived.by((): [number, number] | null => {
		let rangeClause: Clause | null = null;
		sourceGroup.selection.forEach((clause) => {
			if (!rangeClause && clause.schema?.kind === 'range') rangeClause = clause;
		});
		const values = (rangeClause as Clause | null)?.schema?.values as number[] | undefined;
		return values?.length ? [values[0], values[1]] : null;
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

	// Tracks only the derived extent and the column it filters. The rest runs
	// untracked: writing to the target group reads state it then writes, which
	// would make the effect re-run itself without end.
	$effect(() => {
		const extent = derivedExtent;
		const ref = columnRef;
		const fieldStr = resolvedField ?? '';
		untrack(() => emitDerived(extent, ref, fieldStr));
	});

	function emitDerived(extent: [number, number] | null, ref: typeof columnRef, fieldStr: string) {
		if (!extent) {
			// Clear derived filter when primary is cleared
			if (lastEmittedMin != null) {
				lastEmittedMin = null;
				lastEmittedMax = null;
				targetGroup.removeManual(sourceKey);
			}
			return;
		}

		const dataMin = Math.min(extent[0], extent[1]);
		const dataMax = Math.max(extent[0], extent[1]);

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

		if (!ref) return;

		targetGroup.upsertManual(sourceKey, isBetween(ref, [dataMin, dataMax]), [dataMin, dataMax], {
			kind: 'range',
			column: fieldStr,
			label: fieldStr,
			values: [dataMin, dataMax]
		});
	}

	// =========================================================================
	// Relay non-axis clauses from source → target
	// =========================================================================

	const relay = new ClauseRelay(sourceGroup, targetGroup);
	/** Does nothing: forEach(track) only subscribes the effect to every clause. */
	const track = () => {};

	// Tracks only the source group's clauses and what decides which to relay.
	// The writes to the target group run untracked: tracked, they made this
	// effect re-run itself without end once the source had a clause to relay
	// (a day-of-week toggle beside the brush).
	$effect(() => {
		const enabled = relayClauses;
		const fieldStr = resolvedField ?? '';
		sourceGroup.selection.forEach(track);
		untrack(() => relay.sync(enabled, fieldStr));
	});

	onMount(() => {
		return () => {
			targetGroup.removeManual(sourceKey);
			relay.clear();
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
