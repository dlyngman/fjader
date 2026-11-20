<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import { AXIS_REGISTRY, type AxisRegistry, type FrameSpec } from '../axes/axis-registry.svelte';

	/**
	 * The plot area's border: a 1 CSS px frame around the inner plot box.
	 * Drawn on the GPU in cell space (`PlotBorderRenderer`): this component
	 * declares the frame in the chart's registry wherever it is placed, and
	 * `WebGPUCanvas` draws it.
	 */
	const registry = getContext<AxisRegistry | undefined>(AXIS_REGISTRY);
	const spec: FrameSpec = {
		id: `frame-${crypto.randomUUID().slice(0, 8)}`
	};
	const unregister = registry?.registerFrame(spec);
	onDestroy(() => unregister?.());
</script>
