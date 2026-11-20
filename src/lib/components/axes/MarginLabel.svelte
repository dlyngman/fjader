<script lang="ts">
	import { declareOverlay } from '$lib/components/charts/declarations.svelte';
	import MarginLabelCell from './MarginLabelCell.svelte';

	/**
	 * The pointer's values, in the margins: x above the plot, y to its right.
	 * A declaration: each cell draws it in its unclipped margins
	 * (MarginLabelCell), over the plot and the axes, from its own hover point.
	 */
	interface Props {
		show?: 'both' | 'x' | 'y';
	}

	let { show = 'both' }: Props = $props();

	declareOverlay(cell, { slot: 'margins' });
</script>

{#snippet cell()}
	<MarginLabelCell {show} />
{/snippet}
