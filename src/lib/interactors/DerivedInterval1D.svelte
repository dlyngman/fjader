<script lang="ts">
	import { declareOverlay } from '$lib/components/charts/declarations.svelte';
	import DerivedInterval1DCell from './DerivedInterval1DCell.svelte';

	/**
	 * A brush range derived from another selection (shifted by `offset`). A declaration: each cell
	 * draws it in its interactors slot (DerivedInterval1DCell), above the plot's hit target, from
	 * its own pointer events.
	 */
	interface Props {
		sourceSelection: string;
		selection?: string;
		offset: string;
		axis?: 'x' | 'y';
		relayClauses?: boolean;
	}

	let {
		sourceSelection,
		selection = 'derived',
		offset,
		axis = 'x',
		relayClauses = true
	}: Props = $props();

	declareOverlay(cell, { slot: 'interactors' });
</script>

{#snippet cell()}
	<DerivedInterval1DCell {sourceSelection} {selection} {offset} {axis} {relayClauses} />
{/snippet}
