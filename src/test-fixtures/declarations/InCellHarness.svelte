<script lang="ts">
	import { setContext } from 'svelte';
	import InCell from '$lib/components/charts/InCell.svelte';
	import {
		DECLARATION_CHART,
		DECLARATION_REGISTRY,
		type DeclarationChart,
		type DeclarationRegistry
	} from '$lib/components/charts/declarations.svelte';
	import InCellProbe from './InCellProbe.svelte';

	/**
	 * Test fixture (declarations.harness.test.ts), outside src/lib so it is not
	 * packaged: a probe placed as the chart's child and inside InCell, as a
	 * cell renders its overlays.
	 */
	let { registry, probe }: { registry: DeclarationRegistry; probe: 'declare' | 'chart' } = $props();
	setContext(DECLARATION_REGISTRY, registry);
	setContext(DECLARATION_CHART, {} as DeclarationChart);
</script>

<InCellProbe {probe} id="child" />
<InCell><InCellProbe {probe} id="in-cell" /></InCell>
