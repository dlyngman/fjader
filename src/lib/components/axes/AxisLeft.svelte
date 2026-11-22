<script lang="ts">
	import { declareInChart } from '../charts/declarations.svelte';
	import type { AxisSpec, TickFormat } from './axis-spec';

	/**
	 * The y axis, at the plot's left: its ticks, their labels, and its title (the
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
		 * Draw the axis title (default): the scale's label, else the column its
		 * marks show. An axis showing an expression (`count()`, a date function) or
		 * several columns has no title without a label. An empty label or `false`
		 * draws none; with `false` a label still names the scale, so charts sharing
		 * it still link their zoom.
		 */
		title?: boolean;
		/**
		 * How far left of the axis the title sits, in px (default 32), or `'auto'`:
		 * clear of the widest tick label, as far as the chart's left margin allows.
		 */
		titleOffset?: number | 'auto';
		/**
		 * Where the title goes: `'side'` (default), rotated beside the tick labels, or
		 * `'top'`, horizontal above the plot at the axis. `'top'` cannot meet the tick
		 * labels, so it needs no `titleOffset` and no room in the left margin; it takes
		 * the space above the plot (the chart's top margin).
		 */
		titlePlacement?: 'side' | 'top';
	}

	let {
		ticksNumber = 5,
		tickFormat = null,
		title = true,
		titleOffset = 32,
		titlePlacement = 'side'
	}: Props = $props();
	// A pure declaration: it reads no chart context here. What the axis does
	// per cell, including handing a custom tickFormat to the scale (for
	// tooltips and MarginLabel), runs in GpuAxis.
	const spec: AxisSpec = {
		id: `axis-left-${crypto.randomUUID().slice(0, 8)}`,
		side: 'left',
		get ticksNumber() {
			return ticksNumber;
		},
		get tickFormat() {
			return tickFormat;
		},
		get title() {
			return title;
		},
		titleAnchor: 'center',
		get titleOffset() {
			return titleOffset;
		},
		get titlePlacement() {
			return titlePlacement;
		}
	};
	declareInChart('axis', spec);
</script>
