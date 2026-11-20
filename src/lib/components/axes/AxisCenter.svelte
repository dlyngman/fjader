<script lang="ts">
	import { declareOverlay } from '$lib/components/charts/declarations.svelte';
	import AxisCenterCell from './AxisCenterCell.svelte';

	/**
	 * A y axis drawn inside the plot, at a data value on x (or the middle). A
	 * declaration: each cell draws it in its clipped foreground (AxisCenterCell).
	 */
	interface Props {
		/** The x value the axis sits at (data-anchored mode). */
		anchor?: number;
		/** Keep it at the plot's middle instead of following `anchor`. */
		fixed?: boolean;
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
		labelSide?: 'left' | 'right';
	}

	let {
		anchor = 0,
		fixed = false,
		ticksNumber = 5,
		tickFormat = null,
		labelSide = 'left'
	}: Props = $props();

	declareOverlay(cell, { slot: 'clipped' });
</script>

{#snippet cell()}
	<AxisCenterCell {anchor} {fixed} {ticksNumber} {tickFormat} {labelSide} />
{/snippet}
