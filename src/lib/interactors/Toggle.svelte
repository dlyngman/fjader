<script lang="ts">
	import { declareOverlay } from '$lib/components/charts/declarations.svelte';
	import ToggleCell from './ToggleCell.svelte';

	/**
	 * Click selection on a band axis's labels: toggles the field's categories. A declaration: each
	 * cell draws it in its interactors slot (ToggleCell), above the plot's hit target, from its own
	 * pointer events.
	 */
	interface Props {
		selection?: string;
		field: string | string[];
	}

	let { selection, field }: Props = $props();

	declareOverlay(cell, { slot: 'interactors' });
</script>

{#snippet cell()}
	<ToggleCell {selection} {field} />
{/snippet}
