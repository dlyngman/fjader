<script lang="ts">
	import { declareOverlay } from '$lib/components/charts/declarations.svelte';
	import CrosshairCell from './CrosshairCell.svelte';

	/**
	 * Lines through the pointer, in each cell of the chart. A declaration: each
	 * cell draws it in its clipped foreground (CrosshairCell), from its own hover
	 * point.
	 */
	interface Props {
		show?: 'both' | 'x' | 'y';
	}

	let { show = 'both' }: Props = $props();

	declareOverlay(cell, { slot: 'clipped' });
</script>

{#snippet cell()}
	<CrosshairCell {show} />
{/snippet}
