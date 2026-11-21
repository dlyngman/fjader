<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { declareOverlay, getDeclarationChart } from '$lib/components/charts/declarations.svelte';
	import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import { CellPixels } from './interval-drag.svelte';
	import ParallelAxisSource, { type ParallelAxis } from './ParallelAxisSource.svelte';
	import ParallelBrushesCell from './ParallelBrushesCell.svelte';

	/**
	 * Brushes on a parallel coordinates chart's axes.
	 *
	 * A declaration, split by responsibility as Interval1D is: this keeps one
	 * selection source and drag per axis (ParallelAxisSource), once for the
	 * chart, from the shared parallel scales; each cell (ParallelBrushesCell)
	 * places the axes at its own width, finds the axis under its pointer, drives
	 * that axis's drag through its own scale and draws every axis's range.
	 */
	interface Props {
		/** Filter group name: which FilterGroup these brushes write to. */
		selection?: string;
		/**
		 * When true, the brushes skip their own chart (standard crossfilter). When
		 * false (the default), they filter it, as parallel coordinates usually do.
		 */
		cross?: boolean;
	}

	let { selection, cross = false }: Props = $props();

	const chart = getDeclarationChart('ParallelBrushes');
	const filterGroup = getContext<FilterGroupRegistry>('filter-groups').get(
		untrack(() => selection)
	);
	const skips = untrack(() => cross) ? chart.config : null;

	const owner = chart.chartId;

	/**
	 * Each axis's state (source, drag), by column, created and dropped by its
	 * ParallelAxisSource. By column, not by position: removing a column
	 * renumbers the axes, and a brush must stay on its own.
	 */
	const axes = new SvelteMap<string, ParallelAxis>();
	const pixels = new CellPixels();

	const ps = $derived(chart.parallelScales);

	/** An axis's scale state, looked up by column: removing a column renumbers the axes. */
	function scaleStateOf(col: string): LinearScaleState | null {
		if (!ps) return null;
		const i = ps.columns.indexOf(col);
		return i < 0 ? null : (ps.scaleStates[i] as LinearScaleState);
	}

	declareOverlay(cell, { slot: 'interactors' });
</script>

{#if ps}
	{#each ps.columns as col (col)}
		<ParallelAxisSource
			{filterGroup}
			column={col}
			{owner}
			chart={skips}
			scaleState={() => scaleStateOf(col)}
			{pixels}
			{axes}
		/>
	{/each}
{/if}

{#snippet cell()}
	<ParallelBrushesCell {axes} {pixels} />
{/snippet}
