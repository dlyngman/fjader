<!--
  HoverIndicator.svelte - SVG circle highlighting the matched data point.

  Renders in the SVG foreground layer at the matched point's screen coordinates.
  Only shows for point-like marks (dots), not area marks (bars/rects).
-->
<script>
	import { getContext } from 'svelte';

	const c = getContext('chart');

	let tm = $derived(c?.tooltipManager);
	let show = $derived(
		tm?.visible &&
			tm.currentMarkType === 'dot' &&
			tm.matchedScreenX != null &&
			tm.matchedScreenY != null
	);
</script>

{#if show}
	<circle
		cx={tm.matchedScreenX}
		cy={tm.matchedScreenY}
		r="6"
		class="hover-indicator"
	/>
{/if}

<style>
	.hover-indicator {
		fill: none;
		/* stroke: white; */
		stroke: red;
		stroke-width: 2;
		pointer-events: none;
	}
</style>
