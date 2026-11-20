<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { declareOverlay } from '$lib/components/charts/declarations.svelte';
	import type { ChartContext } from '$lib/types';

	/**
	 * Custom SVG in every cell of the chart, in plot coordinates:
	 *
	 *   <SvgLayer>
	 *     {#snippet children(cell)}
	 *       <line x1={0} x2={cell.innerWidth} y1={cell.yScale(18)} y2={cell.yScale(18)} />
	 *     {/snippet}
	 *   </SvgLayer>
	 *
	 * `cell` is the cell's chart context: its scales, size and hover point. Drawn
	 * in the cell's foreground, clipped to the plot; `clip={false}` draws in the
	 * margins too, taking no pointer events. The same path as the built-in
	 * overlays (declareOverlay).
	 */
	interface Props {
		clip?: boolean;
		/** Draw order among the cell's overlays in the same slot, lower first. */
		zIndex?: number;
		children: Snippet<[ChartContext]>;
	}

	let { clip = true, zIndex = 0, children }: Props = $props();

	untrack(() => declareOverlay(children, { slot: clip ? 'clipped' : 'margins', zIndex }));
</script>
