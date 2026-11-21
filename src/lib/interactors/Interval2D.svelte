<script lang="ts">
	import { declareOverlay } from '$lib/components/charts/declarations.svelte';
	import type { FieldRef } from '$lib/types';
	import Interval2DCell from './Interval2DCell.svelte';

	/**
	 * A two-axis brush: drag in the plot to select a rectangle. A declaration: each cell draws it
	 * in its interactors slot (Interval2DCell), above the plot's hit target, from its own pointer
	 * events.
	 */
	interface Props {
		selection?: string;
		xField?: FieldRef;
		yField?: FieldRef;
	}

	let { selection, xField, yField }: Props = $props();

	declareOverlay(cell, { slot: 'interactors' });
</script>

{#snippet cell()}
	<Interval2DCell {selection} {xField} {yField} />
{/snippet}
