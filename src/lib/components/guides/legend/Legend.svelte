<script lang="ts">
	import { getContext } from 'svelte';
	import OrdinalColorLegend from './OrdinalColorLegend.svelte';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
	interface Props {
		color?: string | null;
		selection?: string;
		title?: string | null;
		columns?: number | null;
		swatchSize?: number;
		swatchRadius?: number;
		className?: string;
		orientation?: 'horizontal' | 'vertical' | null;
	}

	let {
		color = null,
		selection: selectionName = undefined,
		title = null,
		columns = null,
		swatchSize = 15,
		swatchRadius = 0,
		className = '',
		orientation = null
	}: Props = $props();

	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const getLegendPosition = getContext<(() => string) | undefined>('legend-position');

	const effectiveOrientation = $derived(
		orientation ?? (getLegendPosition?.() === 'right' ? 'vertical' : 'horizontal')
	);

	// Reactive: SvelteMap triggers re-run when scales are added/removed
	const colorScaleState = $derived.by(() => {
		if (!color || !scaleRegistry) return null;
		return scaleRegistry.getScaleByField(color, 'color');
	});

	const effectiveTitle = $derived(title ?? color ?? '');
</script>

{#if colorScaleState?.ready && (colorScaleState as ColorScaleState).isOrdinal}
	<OrdinalColorLegend
		scaleState={colorScaleState as ColorScaleState}
		selection={selectionName}
		field={color}
		{title}
		{columns}
		{swatchSize}
		{swatchRadius}
		{className}
		orientation={effectiveOrientation}
	/>
{/if}
