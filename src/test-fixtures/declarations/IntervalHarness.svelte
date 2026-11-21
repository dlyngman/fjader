<script lang="ts">
	import { setContext } from 'svelte';
	import Interval1D from '$lib/interactors/Interval1D.svelte';
	import Interval2D from '$lib/interactors/Interval2D.svelte';
	import FakeCell from './FakeCell.svelte';
	import {
		DECLARATION_CHART,
		DECLARATION_REGISTRY,
		type DeclarationChart,
		type DeclarationRegistry
	} from '$lib/components/charts/declarations.svelte';
	import type { ChartContext, ScaleStateInstance } from '$lib/types';

	/**
	 * Test fixture (declaration-scope.test.ts), outside src/lib so it is not
	 * packaged: one brush placed as a chart's child, and a cell per chart
	 * context in `cells` rendering what it declared.
	 */
	let {
		registry,
		groups,
		cells,
		kind,
		xScaleState,
		yScaleState
	}: {
		registry: DeclarationRegistry;
		groups: unknown;
		cells: ChartContext[];
		kind: '1d' | '2d';
		xScaleState: ScaleStateInstance;
		yScaleState: ScaleStateInstance;
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
		yLabel: null
	};
	setContext(DECLARATION_REGISTRY, registry);
	setContext(DECLARATION_CHART, chart);
	setContext('filter-groups', groups);
</script>

{#if kind === '1d'}
	<Interval1D selection="brush" />
{:else}
	<Interval2D selection="brush" />
{/if}
{#each cells as cell, i (i)}
	<FakeCell {registry} cellId={`cell-${i}`} chart={cell} />
{/each}
