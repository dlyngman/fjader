<script lang="ts">
	import { declareOverlay } from '$lib/components/charts/declarations.svelte';
	import ParallelBrushesCell from './ParallelBrushesCell.svelte';

	/**
	 * Brushes on a parallel coordinates chart's axes. A declaration: each cell draws it in its
	 * interactors slot (ParallelBrushesCell), above the plot's hit target, from its own pointer
	 * events.
	 */
	interface Props {
		selection?: string;
		cross?: boolean;
	}

	let { selection, cross = false }: Props = $props();

	declareOverlay(cell, { slot: 'interactors' });
</script>

{#snippet cell()}
	<ParallelBrushesCell {selection} {cross} />
{/snippet}
