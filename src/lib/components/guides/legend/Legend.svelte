<script>
	import { getContext } from 'svelte';
	import OrdinalColorLegend from './OrdinalColorLegend.svelte';

	let {
		color = null,
		title = null,
		columns = null,
		swatchSize = 15,
		swatchRadius = 0,
		className = '',
		orientation = null
	} = $props();

	const scaleRegistry = getContext('scale-registry');
	const getLegendPosition = getContext('legend-position');

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

{#if colorScaleState?.ready && colorScaleState.isOrdinal}
	<OrdinalColorLegend
		scaleState={colorScaleState}
		{title}
		{columns}
		{swatchSize}
		{swatchRadius}
		{className}
		orientation={effectiveOrientation}
	/>
{/if}
