<script lang="ts">
	import { setContext } from 'svelte';
	import type { DeclarationRegistry } from '$lib/components/charts/declarations.svelte';
	import type { ChartContext } from '$lib/types';

	/**
	 * Test fixture: a cell as far as a Toggle's cell part reads one (its
	 * activators, its click hook), rendering its interactors slot as ChartCell
	 * does.
	 */
	let { registry, chart }: { registry: DeclarationRegistry; chart: ChartContext } = $props();
	setContext('chart', chart);
</script>

{#each registry.overlays('interactors') as declared (declared)}
	{@render declared.snippet(chart)}
{/each}
