<script lang="ts">
	import { declareInChart, type FrameSpec } from '../charts/declarations.svelte';

	/**
	 * The plot area's border: a 1 CSS px frame around the inner plot box.
	 * Drawn on the GPU in cell space (`PlotBorderRenderer`): this component
	 * declares the frame in the chart (charts/declarations) wherever it is
	 * placed, and the cell's `WebGPUCanvas` draws it.
	 */
	const spec: FrameSpec = {
		id: `frame-${crypto.randomUUID().slice(0, 8)}`
	};
	declareInChart('frame', spec);
</script>
