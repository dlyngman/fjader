<script lang="ts">
	import { getContext } from 'svelte';
	import OrdinalColorLegend from './OrdinalColorLegend.svelte';
	import ContinuousColorLegend from './ContinuousColorLegend.svelte';
	import { inferLegendScale } from './infer-legend-scale';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
	import {
		DECLARATION_CHART,
		DECLARATION_REGISTRY,
		declareLegend,
		type DeclarationChart,
		type DeclarationRegistry,
		type LegendPosition
	} from '$lib/components/charts/declarations.svelte';

	/**
	 * A color legend for the field `color` (in a chart, by default the one
	 * field its marks color by): swatches for a categorical scale
	 * (click to filter `selection`), a ramp for a continuous one.
	 *
	 * As a chart's child (`ChartContainer`'s children) it is a declaration: the
	 * chart renders it once, above the plot or to its right (`position`),
	 * however the chart is faceted. Several at one position render in
	 * registration order. Outside a chart it renders where it is placed.
	 */
	interface Props {
		color?: string | null;
		selection?: string;
		title?: string | null;
		columns?: number | null;
		swatchSize?: number;
		swatchRadius?: number;
		className?: string;
		/** Where the chart places it: above the plot (default) or to its right. */
		position?: LegendPosition;
		/** Default: vertical at the right, horizontal on top. */
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
		position = 'top',
		orientation = null
	}: Props = $props();

	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// In a chart, the chart renders it; outside one, it renders here.
	const inChart = !!getContext<DeclarationRegistry | undefined>(DECLARATION_REGISTRY);
	if (inChart)
		declareLegend(legend, {
			get position() {
				return position;
			}
		});

	const effectiveOrientation = $derived(
		orientation ?? (position === 'right' ? 'vertical' : 'horizontal')
	);

	// In a chart, with no `color`: the one scale the chart's marks color by.
	const chart = inChart ? getContext<DeclarationChart | undefined>(DECLARATION_CHART) : undefined;
	// Each warning once while it holds; again if it returns after resolving.
	let warned: string | null = null;
	const inferredScale = $derived.by((): ColorScaleState | null => {
		if (color || !chart) return null;
		const { scale, warning } = inferLegendScale(chart.colorScales);
		if (warning && warning !== warned) console.warn(warning);
		warned = warning;
		return scale;
	});

	// Reactive: SvelteMap triggers re-run when scales are added/removed
	const colorScaleState = $derived.by(() => {
		if (!color) return inferredScale;
		if (!scaleRegistry) return null;
		return scaleRegistry.getScaleByField(color, 'color');
	});
	const field = $derived(color ?? inferredScale?.field ?? null);

	const effectiveTitle = $derived(title ?? field ?? '');
</script>

{#if !inChart}
	{@render legend()}
{/if}

{#snippet legend()}
	<!-- Keyed by the field: a legend registers its toggle on the field once, at
	     init, so an inferred field that changes (the chart's marks now color by
	     another) needs a new one, or clicks would still toggle the old field. -->
	{#key field}
		{@render byScale()}
	{/key}
{/snippet}

{#snippet byScale()}
	{#if colorScaleState?.ready && (colorScaleState as ColorScaleState).isOrdinal}
		<OrdinalColorLegend
			scaleState={colorScaleState as ColorScaleState}
			selection={selectionName}
			{field}
			{title}
			{columns}
			{swatchSize}
			{swatchRadius}
			{className}
			orientation={effectiveOrientation}
		/>
	{:else if colorScaleState?.ready && (colorScaleState as ColorScaleState).isContinuous}
		<ContinuousColorLegend
			scaleState={colorScaleState as ColorScaleState}
			selection={selectionName}
			title={effectiveTitle}
			orientation={effectiveOrientation}
			{className}
		/>
	{/if}
{/snippet}
