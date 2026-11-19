<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import type { ChartContext, ContinuousScaleState } from '$lib/types';
	import { AXIS_REGISTRY, type AxisRegistry, type AxisSpec } from './axis-registry.svelte';

	/**
	 * The x axis, below the plot: its ticks, their labels, and the scale's label
	 * as its title. Drawn on the GPU in the chart's margins: this component
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
	const c = getContext<ChartContext>('chart');

	// Propagate custom format to scale state once it exists (for MarginLabel, tooltips, etc.)
	$effect(() => {
		const s = c.xScaleState;
		if (tickFormat && s && s.scaleType !== 'band')
			(s as ContinuousScaleState).setCustomFormat(tickFormat);
	});

	const registry = getContext<AxisRegistry | undefined>(AXIS_REGISTRY);
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
	const unregister = registry?.register(spec);
	onDestroy(() => unregister?.());
</script>
