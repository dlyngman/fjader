<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import { AXIS_REGISTRY, type AxisRegistry, type ParallelAxesSpec } from './axis-registry.svelte';

	/**
	 * A parallel coordinates chart's axes: one per column, with its ticks, their
	 * labels and the column's name, following the columns as they are dragged
	 * into a new order. Drawn on the GPU, over the lines: this component declares
	 * the axes (axis-registry), wherever it is placed, and the chart's canvas
	 * draws them (GpuParallelAxes).
	 */
	interface Props {
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
	}

	let { ticksNumber = 5, tickFormat = null }: Props = $props();

	const registry = getContext<AxisRegistry | undefined>(AXIS_REGISTRY);
	const spec: ParallelAxesSpec = {
		id: `parallel-axes-${crypto.randomUUID().slice(0, 8)}`,
		get ticksNumber() {
			return ticksNumber;
		},
		get tickFormat() {
			return tickFormat;
		}
	};
	const unregister = registry?.registerParallel(spec);
	onDestroy(() => unregister?.());
</script>
