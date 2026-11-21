<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { isBetween } from '@uwdata/mosaic-sql';
	import { declareOverlay, getDeclarationChart } from '$lib/components/charts/declarations.svelte';
	import { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import type { Clause } from '$lib/query-engine/CrossfilterSelection.svelte';
	import { buildColumnRef } from './brush-utils';
	import { parseOffset, applyOffset, formatOffsetLabel } from './calendar-offset';
	import { ClauseRelay } from './relay-clauses';
	import DerivedInterval1DCell from './DerivedInterval1DCell.svelte';

	/**
	 * A brush range derived from another selection: reads the source group's
	 * range, shifts it by a calendar `offset`, and writes the shifted predicate
	 * to the target group (`selection`), relaying the source's other clauses.
	 *
	 * A declaration, split by responsibility as Toggle is: this derives the
	 * range from the shared time scale and writes it, once for the chart; each
	 * cell (DerivedInterval1DCell) only draws it, clamped to its own scale and
	 * size. In a facet grid that is one clause and one relay, not one per cell.
	 */
	interface Props {
		sourceSelection: string;
		selection?: string;
		offset: string;
		axis?: 'x' | 'y';
		relayClauses?: boolean;
	}

	let {
		sourceSelection,
		selection = 'derived',
		offset,
		axis = 'x',
		relayClauses = true
	}: Props = $props();

	const chart = getDeclarationChart('DerivedInterval1D');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const sourceGroup = filterGroups.get(untrack(() => sourceSelection));
	const targetGroup = filterGroups.get(untrack(() => selection));
	const isX = untrack(() => axis) === 'x';
	const parsedOffset = parseOffset(untrack(() => offset));
	const label = formatOffsetLabel(untrack(() => offset));

	const scaleState = $derived(isX ? chart.xScaleState : chart.yScaleState);
	const resolvedField = $derived(
		(isX ? chart.xColumnName : chart.yColumnName) ?? (isX ? chart.xLabel : chart.yLabel)
	);
	const columnRef = $derived.by(() =>
		buildColumnRef(
			resolvedField,
			scaleState && 't0' in scaleState ? (scaleState as { t0?: Date | null }) : null
		)
	);

	const sourceKey = `derived-${isX ? 'x' : 'y'}-${chart.chartId}`;

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

	/** The primary range shifted by the calendar offset, in the time scale's offsets. */
	const derivedExtent = $derived.by((): [number, number] | null => {
		if (!primaryRange || !(scaleState instanceof TimeScaleState) || !scaleState.t0) return null;

		const minDate = scaleState.offsetToDate(primaryRange[0]);
		const maxDate = scaleState.offsetToDate(primaryRange[1]);
		if (!minDate || !maxDate) return null;

		const derivedMin = scaleState.dateToOffset(applyOffset(minDate, parsedOffset));
		const derivedMax = scaleState.dateToOffset(applyOffset(maxDate, parsedOffset));
		if (derivedMin == null || derivedMax == null) return null;
		return [derivedMin, derivedMax];
	});

	// The range last written, so an unchanged one is skipped; null: none written.
	let lastMin: number | null = null;
	let lastMax: number | null = null;

	// Tracks only the derived extent and the column it filters. The rest runs
	// untracked: writing to the target group reads state it then writes, which
	// would make the effect re-run itself without end.
	$effect(() => {
		const extent = derivedExtent;
		const ref = columnRef;
		const fieldStr = resolvedField ?? '';
		untrack(() => write(extent, ref, fieldStr));
	});

	function write(extent: [number, number] | null, ref: typeof columnRef, fieldStr: string) {
		if (!extent) {
			// The primary was cleared: clear the derived filter.
			if (lastMin != null) {
				lastMin = null;
				lastMax = null;
				targetGroup.removeManual(sourceKey);
			}
			return;
		}
		const min = Math.min(extent[0], extent[1]);
		const max = Math.max(extent[0], extent[1]);
		if (lastMin != null && Math.abs(min - lastMin) < 1e-10 && Math.abs(max - lastMax!) < 1e-10) {
			return;
		}
		// Recorded only once written: without a column yet, the next run writes it.
		if (!ref) return;
		lastMin = min;
		lastMax = max;
		targetGroup.upsertManual(sourceKey, isBetween(ref, [min, max]), [min, max], {
			kind: 'range',
			column: fieldStr,
			label: fieldStr,
			values: [min, max]
		});
	}

	// Relay non-axis clauses from source to target, once for the chart.
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

	onDestroy(() => {
		targetGroup.removeManual(sourceKey);
		relay.clear();
	});

	declareOverlay(cell, { slot: 'interactors' });
</script>

{#snippet cell()}
	<DerivedInterval1DCell extent={() => derivedExtent} axis={isX ? 'x' : 'y'} {label} />
{/snippet}
