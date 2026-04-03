<script lang="ts">
	import { setContext } from 'svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { Snippet } from 'svelte';

	let { queryEngine, children }: { queryEngine: QueryEngine; children: Snippet } = $props();

	setContext('query-engine', queryEngine);
</script>

{@render children()}
