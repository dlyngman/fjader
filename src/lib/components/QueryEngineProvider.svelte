<script lang="ts">
	import { setContext } from 'svelte';
	import { QueryEngine } from '$lib/query-engine/QueryEngine';
	import { FilterGroup } from '$lib/query-engine/FilterGroup.svelte';
	import type { Snippet } from 'svelte';

	let { queryEngine, children }: { queryEngine: QueryEngine; children: Snippet } = $props();

	setContext('query-engine', queryEngine);

	// Always provide a FilterGroup for crossfilter
	const filterGroup = new FilterGroup();
	setContext('filter-group', filterGroup);
</script>

{@render children()}
