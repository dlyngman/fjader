<!--
  HoverIndicator.svelte - SVG circles highlighting matched data points.

  Renders in the SVG foreground layer at matched points' screen coordinates.
  When multiple points match, the focused point (cycled with [ / ]) renders
  with full indicator styling; others show as small colored dots.
  - Dots: colored ring with contrasting outline, sized to the actual dot radius
  - Lines/areas: small filled circle with contrasting outline
  - Bars/rects: no indicator (hovered element is visually obvious)
-->
<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext } from '$lib/types';

	const c = getContext<ChartContext>('chart');

	const indicatorTypes = new Set(['dot', 'line', 'areay', 'areax']);

	let tm = $derived(c?.tooltipManager);
	let points = $derived(tm?.matchedPoints ?? []);
	let focusedIdx = $derived(tm?.focusedIndex ?? 0);
	let show = $derived(
		tm?.visible &&
			tm.currentMarkType != null &&
			indicatorTypes.has(tm.currentMarkType) &&
			points.length > 0
	);
	let isDot = $derived(tm?.currentMarkType === 'dot');
	let fallbackColor = 'var(--fjader-text-muted, #d1d5db)';

	// Radius for the indicator circle, based on the actual rendered dot radius
	let dotR = $derived(tm?.matchedRadius ?? 3);
	// Dots: ring with a gap around the dot. Lines/areas: slightly larger filled circle.
	let ringR = $derived(isDot ? dotR + 2.5 : dotR + 1.5);
	// Non-focused: slightly larger than rendered dot so it's visible over the line/area
	let dimR = $derived(Math.max(dotR + 1.5, 4));
</script>

{#if show}
	<!-- Non-focused: small colored dots for spatial context -->
	{#each points as pt, i (i)}
		{@const color = pt.color ?? fallbackColor}
		{#if i !== focusedIdx && pt.screenX != null && pt.screenY != null}
			<circle
				cx={pt.screenX}
				cy={pt.screenY}
				r={dimR}
				class="hover-indicator"
				fill={color}
				opacity="0.7"
			/>
		{/if}
	{/each}
	<!-- Focused: full indicator -->
	{@const pt = points[focusedIdx]}
	{#if pt?.screenX != null && pt?.screenY != null}
		{@const color = pt.color ?? fallbackColor}
		{#if isDot}
			<circle
				cx={pt.screenX}
				cy={pt.screenY}
				r={ringR}
				class="hover-indicator outline"
				fill="none"
				stroke-width="3"
			/>
			<circle
				cx={pt.screenX}
				cy={pt.screenY}
				r={ringR}
				class="hover-indicator"
				fill="none"
				stroke={color}
				stroke-width="1.5"
			/>
		{:else}
			<circle cx={pt.screenX} cy={pt.screenY} r={ringR} class="hover-indicator" fill={color} />
		{/if}
	{/if}
{/if}

<style>
	.hover-indicator {
		pointer-events: none;
		outline: none; /* prevent host CSS (e.g. marimo/Jupyter) adding bounding-box outlines */
	}

	.outline {
		stroke: var(--fjader-bg, white);
	}
</style>
