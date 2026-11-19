<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import type { ChartContext, ContinuousScaleState } from '$lib/types';
	import { AXIS_REGISTRY, type AxisRegistry, type AxisSpec } from './axis-registry.svelte';

	/**
	 * The y axis, at the plot's left: its ticks, their labels, and the scale's
	 * label as its title. Drawn on the GPU in the chart's margins: this component
	 * declares the axis (axis-registry), wherever it is placed, and the chart's
	 * canvas draws it (GpuAxis).
	 */
	interface Props {
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
		/**
		 * Draw the scale's label as the axis title (default). `false` draws none; the
		 * label still names the scale, so charts sharing it still link their zoom.
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
	const c = getContext<ChartContext>('chart');

	// Propagate custom format to scale state once it exists (for MarginLabel, tooltips, etc.)
	$effect(() => {
		const s = c.yScaleState;
		if (tickFormat && s && s.scaleType !== 'band')
			(s as ContinuousScaleState).setCustomFormat(tickFormat);
	});

	const registry = getContext<AxisRegistry | undefined>(AXIS_REGISTRY);
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
	const unregister = registry?.register(spec);
	onDestroy(() => unregister?.());
</script>
