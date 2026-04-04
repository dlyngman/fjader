<script lang="ts">
	/**
	 * TODO: Migrate to FilterGroup (V2 query engine).
	 *
	 * This component still uses Mosaic's SelectionRegistry. Migration is blocked
	 * by a design question: DerivedInterval1D reads from a "source" named selection
	 * (e.g. "brush") and writes to a separate "derived" named selection (e.g.
	 * "comparison"). Marks opt into which selection filters them via selection="brush"
	 * or selection="comparison".
	 *
	 * In V2, there is one FilterGroup/CrossfilterSelection per page — no named
	 * selections. All marks share one predicate set, with cross-filter skip via
	 * excludeMarkIds. To migrate DerivedInterval1D:
	 *
	 * 1. Read source brush extent from filterGroup.items (find item with
	 *    schema.kind === 'range' matching the axis field) instead of sourceGroup.items.
	 *
	 * 2. Write derived extent via filterGroup.upsertManual() with a predicate built
	 *    from isBetween() — same as other interactors.
	 *
	 * 3. Solve the targeting problem: the derived predicate should only affect
	 *    "comparison" marks, not "brush" marks. Options:
	 *    a) Add a mark-group concept to FilterGroup (marks declare a group ID,
	 *       clauses target specific groups).
	 *    b) Use excludeMarkIds to exclude "brush" marks from the derived clause.
	 *       Requires the interactor to know which marks are "brush" vs "comparison"
	 *       — could be inferred from mark selection prop.
	 *    c) Support multiple FilterGroups per page (one per named selection).
	 *
	 * 4. Relay logic (non-axis clauses from source → derived) needs equivalent
	 *    FilterGroup API — currently uses sourceGroup.items + derivedGroup.upsertManual.
	 *
	 * The test/derived-interval route is temporarily broken until this is resolved.
	 * The SelectionBridge components in that route are preserved for now.
	 */
	import { getContext, onMount } from 'svelte';
	import { clauseInterval } from '@uwdata/mosaic-core';
	import GhostBrushOverlay from './GhostBrushOverlay.svelte';
	import { buildColumnRef } from './brush-utils';
	import { parseOffset, applyOffset, formatOffsetLabel } from './calendar-offset';
	import type { ChartContext } from '$lib/types';
	import { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
	import { getSelectionRegistry } from '$lib/selection';
	import type { ClauseSource } from '@uwdata/mosaic-core';
	import type { ScaleDomain } from '@uwdata/mosaic-sql';

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

	const registry = getSelectionRegistry()!;
	const sourceGroup = registry.getGroup(sourceSelection);
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

	// Source string for this derived interactor
	const source = `derived-${axis}-${chart.chartId}`;

	// Own Mosaic selection (for comparison mark filtering)
	const derivedGroup = registry.getGroup(selectionName);
	const { sel: selection, off: unregister } = derivedGroup.createLocal('single', {
		source,
		augment: (clause) => ({
			kind: 'range',
			column:
				typeof resolvedField === 'string'
					? resolvedField
					: (resolvedField?.toString() ?? ''),
			label:
				typeof resolvedField === 'string' ? resolvedField : resolvedField?.toString(),
			values: clause?.value
				? [(clause.value as number[])[0], (clause.value as number[])[1]]
				: []
		})
	});

	// Column reference for Mosaic clause emission
	const columnRef = $derived.by(() =>
		buildColumnRef(
			resolvedField,
			scaleState && 't0' in scaleState ? (scaleState as { t0?: Date | null }) : null
		)
	);

	// =========================================================================
	// Filter Bridge: Watch source selection items → compute derived extent
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
	// Emit derived Mosaic clause
	// =========================================================================

	// Deduplication
	let lastEmittedMin: number | null = null;
	let lastEmittedMax: number | null = null;

	$effect(() => {
		if (!derivedExtent) {
			// Clear derived selection when primary is cleared
			if (lastEmittedMin != null) {
				lastEmittedMin = null;
				lastEmittedMax = null;
				if (selection) {
					selection.update({
						predicate: null,
						source: source as unknown as ClauseSource,
						clients: chart.markClients,
						value: null
					});
				}
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

		if (!selection || !columnRef) return;

		const s = getScale();
		if (!s) return;

		const clause = clauseInterval(columnRef, [dataMin, dataMax] as ScaleDomain, {
			source: source as unknown as ClauseSource,
			clients: chart.markClients,
			scale: {
				type: 'linear',
				domain: s.domain() as ScaleDomain,
				range: s.range() as [number, number]
			}
		});
		selection.update(clause);
	});

	// =========================================================================
	// Relay non-axis clauses from source → derived
	// =========================================================================

	let relayedKeys = new Set<string>();

	$effect(() => {
		if (!relayClauses) {
			for (const key of relayedKeys) derivedGroup.removeManual(key);
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

			if (item.clause?.predicate) {
				const key = `relay:${item.source}`;
				currentKeys.add(key);
				derivedGroup.upsertManual(key, item.clause, item.schema ?? {});
			}
		}

		// Remove stale relayed clauses
		for (const key of relayedKeys) {
			if (!currentKeys.has(key)) derivedGroup.removeManual(key);
		}
		relayedKeys = currentKeys;
	});

	// Pre-aggregation on pointer enter
	function handlePointerEnter() {
		if (!selection?.activate) return;
		const s = getScale();
		if (!s || !columnRef) return;

		const range: ScaleDomain = derivedExtent
			? [
					Math.min(derivedExtent[0], derivedExtent[1]),
					Math.max(derivedExtent[0], derivedExtent[1])
				]
			: [0, 1];

		selection.activate(
			clauseInterval(columnRef, range, {
				source: source as unknown as ClauseSource,
				clients: chart.markClients,
				scale: {
					type: 'linear',
					domain: s.domain() as ScaleDomain,
					range: s.range() as [number, number]
				}
			})
		);
	}

	onMount(() => {
		return () => {
			for (const key of relayedKeys) derivedGroup.removeManual(key);
			relayedKeys = new Set();
			unregister?.();
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
