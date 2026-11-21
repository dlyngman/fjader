<script lang="ts">
	import { declareOverlay } from '$lib/components/charts/declarations.svelte';
	import type { FieldRef } from '$lib/types';
	import Interval1DCell from './Interval1DCell.svelte';

	/**
	 * A one-axis brush: drag in the plot to select a range on x or y. A declaration: each cell
	 * draws it in its interactors slot (Interval1DCell), above the plot's hit target, from its own
	 * pointer events.
	 */
	interface Props {
		/** Filter group name: which selection this brush writes to. */
		selection?: string;
		field?: FieldRef;
		axis?: 'x' | 'y';
	}

	let { selection, field, axis = 'x' }: Props = $props();

	declareOverlay(cell, { slot: 'interactors' });
</script>

{#snippet cell()}
	<Interval1DCell {selection} {field} {axis} />
{/snippet}
