<script lang="ts">
	import { setContext } from 'svelte';
	import { QueryEngine } from '$lib/query-engine/QueryEngine';
	import { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import type { Snippet } from 'svelte';

	let { queryEngine, children }: { queryEngine: QueryEngine; children: Snippet } = $props();

	setContext('query-engine', queryEngine);

	// Provide FilterGroupRegistry (new) — marks/interactors read from this
	const filterGroups = new FilterGroupRegistry();
	setContext('filter-groups', filterGroups);
</script>

{@render children()}
