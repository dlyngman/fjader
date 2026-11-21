<script lang="ts">
	import { setContext } from 'svelte';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import FakeCell from './FakeCell.svelte';
	import {
		DECLARATION_CHART,
		DECLARATION_REGISTRY,
		type DeclarationChart,
		type DeclarationRegistry
	} from '$lib/components/charts/declarations.svelte';
	import type { ChartContext } from '$lib/types';

	/**
	 * Test fixture (declarations.harness.test.ts), outside src/lib so it is not
	 * packaged: one Toggle placed as a chart's child, and a cell per chart
	 * context in `cells` rendering what it declared.
	 */
	let {
		registry,
		groups,
		cells
	}: { registry: DeclarationRegistry; groups: unknown; cells: ChartContext[] } = $props();
	const chart: DeclarationChart = {
		chartId: 'chart',
		config: {} as DeclarationChart['config'],
		xScaleState: null,
		yScaleState: null,
		xColumnName: null,
		yColumnName: null,
		xLabel: null,
		yLabel: null,
		parallelScales: null,
		colorScales: []
	};
	setContext(DECLARATION_REGISTRY, registry);
	setContext(DECLARATION_CHART, chart);
	setContext('filter-groups', groups);
</script>

<Toggle field="island" selection="pick" />
{#each cells as cell, i (i)}
	<FakeCell {registry} chart={cell} />
{/each}
