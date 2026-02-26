<script lang="ts">
	import type { Selection } from '@uwdata/mosaic-core';
	import ChartContainer from '$lib/components/charts/ChartContainer.svelte';
	import WebGPUCanvas from '$lib/components/rendering/WebGPUCanvas.svelte';
	import { resolveMarkEntry } from './MarkRegistry';
	import type { PlotSpec } from './types';

	interface Props {
		spec: PlotSpec;
		params: Record<string, Selection>;
	}

	let { spec, params }: Props = $props();

	const resolvedMarks = $derived(
		spec.marks.map((markSpec) => resolveMarkEntry(markSpec, params))
	);
</script>

<div
	class="diveplot-spec-plot"
	style:width={spec.width ? `${spec.width}px` : '100%'}
	style:height={spec.height ? `${spec.height}px` : undefined}
	style:aspect-ratio={spec.height ? undefined : '4/3'}
	style:min-height={spec.height ? undefined : '300px'}
>
	<ChartContainer
		xLabel={spec.xLabel ?? null}
		yLabel={spec.yLabel ?? null}
		fx={spec.fx ?? null}
		columns={spec.columns ?? null}
		margin={spec.margin}
	>
		{#snippet canvas()}
			<WebGPUCanvas>
				{#snippet canvasComponents()}
					{#each resolvedMarks as { component: MarkComponent, props }, i (i)}
						<MarkComponent {...props} />
					{/each}
				{/snippet}
			</WebGPUCanvas>
		{/snippet}
	</ChartContainer>
</div>

<style>
	.diveplot-spec-plot {
		position: relative;
	}
</style>
