<script lang="ts">
	import { declareInChart } from '../charts/declarations.svelte';
	import type { AxisSpec, TickFormat } from './axis-spec';

	/**
	 * The x axis, below the plot: its ticks, their labels, and its title (the
	 * scale's label, else its column). Drawn on the GPU in the chart's margins:
	 * this component declares the axis (charts/declarations), wherever it is
	 * placed, and the chart's canvas draws it (GpuAxis).
	 */
	interface Props {
		ticksNumber?: number;
		/**
		 * A function, or a d3-format specifier (`'+%'`): either becomes the
		 * scale's format too, for tooltips and the hover readout.
		 */
		tickFormat?: TickFormat | null;
		/**
		 * Draw the axis title (default): the scale's label, else the column it shows
		 * (an aggregate's SQL text, `count(*)`). An empty label or `false` draws
		 * none; with `false` a label still names the scale, so charts sharing it
		 * still link their zoom.
		 */
		title?: boolean;
		/**
		 * Where along the axis the title sits: `'center'` (default), or at the plot's
		 * `'start'` (left) or `'end'` (right) edge.
		 */
		titleAnchor?: 'start' | 'center' | 'end';
	}

	let {
		ticksNumber = 5,
		tickFormat = null,
		title = true,
		titleAnchor = 'center'
	}: Props = $props();
	// A pure declaration: it reads no chart context here. What the axis does
	// per cell, including handing a custom tickFormat to the scale (for
	// tooltips and MarginLabel), runs in GpuAxis.
	const spec: AxisSpec = {
		id: `axis-bottom-${crypto.randomUUID().slice(0, 8)}`,
		side: 'bottom',
		get ticksNumber() {
			return ticksNumber;
		},
		get tickFormat() {
			return tickFormat;
		},
		get title() {
			return title;
		},
		get titleAnchor() {
			return titleAnchor;
		},
		titleOffset: 32,
		titlePlacement: 'side'
	};
	declareInChart('axis', spec);
</script>
