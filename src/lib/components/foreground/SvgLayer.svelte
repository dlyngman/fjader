<script lang="ts">
	import type { Snippet } from 'svelte';
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
	 * `cell` is the cell's chart context: its scales, size and hover point; the
	 * children render once both scales exist. `clip` and `zIndex` apply live. Drawn
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

	declareOverlay(layer, {
		get slot() {
			return clip ? 'clipped' : 'margins';
		},
		get zIndex() {
			return zIndex;
		}
	});
</script>

<!-- The cell's scales exist once its marks have registered them: until then,
     cell.yScale(…) in the children would throw. -->
{#snippet layer(cell: ChartContext)}
	{#if cell.xScale && cell.yScale}{@render children(cell)}{/if}
{/snippet}
