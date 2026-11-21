<script lang="ts">
	import { setContext, type Snippet } from 'svelte';
	import { IN_CELL } from './declarations.svelte';

	/**
	 * Marks what a cell renders per cell (its overlays), for `declareInChart`
	 * and `getDeclarationChart`: a declaring component inside would declare once
	 * per cell. Context belongs to a component, not to a place a snippet is
	 * rendered, so `ChartCell` renders its overlays inside one of these. Renders
	 * no DOM of its own.
	 */
	let { children }: { children: Snippet } = $props();
	setContext(IN_CELL, true);
</script>

{@render children()}
