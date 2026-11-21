<script lang="ts">
	import { setContext } from 'svelte';
	import Interval1D from '$lib/interactors/Interval1D.svelte';
	import Interval2D from '$lib/interactors/Interval2D.svelte';
	import ParallelBrushes from '$lib/interactors/ParallelBrushes.svelte';
	import DerivedIntervalX from '$lib/interactors/DerivedIntervalX.svelte';
	import IntervalX from '$lib/interactors/IntervalX.svelte';
	import IntervalY from '$lib/interactors/IntervalY.svelte';
	import FakeCell from './FakeCell.svelte';
	import {
		DECLARATION_CHART,
		DECLARATION_REGISTRY,
		type DeclarationChart,
		type DeclarationRegistry
	} from '$lib/components/charts/declarations.svelte';
	import type { ChartContext, ScaleStateInstance } from '$lib/types';

	/**
	 * Test fixture (declarations.harness.test.ts), outside src/lib so it is not
	 * packaged: one brush (Interval1D, Interval2D, ParallelBrushes,
	 * DerivedIntervalX, or an IntervalX/IntervalY naming no selection) placed
	 * as a chart's child, and a cell per chart context in `cells` rendering what
	 * it declared.
	 */
	let {
		registry,
		groups,
		cells,
		kind,
		xScaleState,
		yScaleState,
		parallelScales = null
	}: {
		registry: DeclarationRegistry;
		groups: unknown;
		cells: ChartContext[];
		/** `x`/`y`: an IntervalX/IntervalY that names no selection. */
		kind: '1d' | '2d' | 'parallel' | 'derived' | 'x' | 'y';
		xScaleState: ScaleStateInstance;
		yScaleState: ScaleStateInstance;
		parallelScales?: DeclarationChart['parallelScales'];
	} = $props();
	const chart: DeclarationChart = {
		chartId: 'chart',
		config: {} as DeclarationChart['config'],
		get xScaleState() {
			return xScaleState;
		},
		get yScaleState() {
			return yScaleState;
		},
		xColumnName: 'delay',
		yColumnName: 'distance',
		xLabel: null,
		yLabel: null,
		get parallelScales() {
			return parallelScales;
		}
	};
	setContext(DECLARATION_REGISTRY, registry);
	setContext(DECLARATION_CHART, chart);
	setContext('filter-groups', groups);
</script>

{#if kind === '1d'}
	<Interval1D selection="brush" />
{:else if kind === '2d'}
	<Interval2D selection="brush" />
{:else if kind === 'x'}
	<IntervalX />
{:else if kind === 'y'}
	<IntervalY />
{:else if kind === 'parallel'}
	<ParallelBrushes selection="brush" />
{:else}
	<DerivedIntervalX sourceSelection="brush" selection="derived" offset="-1yw" />
{/if}
{#each cells as cell, i (i)}
	<FakeCell {registry} chart={cell} />
{/each}
