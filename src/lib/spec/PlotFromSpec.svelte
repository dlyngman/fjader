<script lang="ts">
	import type { FilterBridge } from '$lib/selection/filter-bridge.svelte';
	import ChartContainer from '$lib/components/charts/ChartContainer.svelte';
	import WebGPUCanvas from '$lib/components/rendering/WebGPUCanvas.svelte';
	import { AxisBottom, AxisLeft, MarginLabel } from '$lib/components/axes';
	import Frame from '$lib/components/background/Frame.svelte';
	import { Grid } from '$lib/components/guides';
	import Crosshair from '$lib/components/foreground/Crosshair.svelte';
	import Legend from '$lib/components/guides/legend/Legend.svelte';
	import IntervalX from '$lib/interactors/IntervalX.svelte';
	import IntervalY from '$lib/interactors/IntervalY.svelte';
	import { resolveMarkEntry } from './MarkRegistry';
	import type { LegendSpec, PlotSpec } from './types';

	interface Props {
		spec: PlotSpec;
		params: Record<string, FilterBridge>;
	}

	let { spec, params }: Props = $props();

	// Find the FilterBridge used by marks in this plot (if any).
	// All marks with a selection key share the same FilterBridge.
	const bridge = $derived.by((): FilterBridge | null => {
		for (const m of spec.marks ?? []) {
			if (typeof m.selection === 'string' && params[m.selection]) {
				return params[m.selection];
			}
		}
		return null;
	});

	const resolvedMarks = $derived(
		(spec.marks ?? []).map((markSpec) => resolveMarkEntry(markSpec, params))
	);

	const legendConfig = $derived.by((): LegendSpec | null => {
		if (!spec.legend) return null;
		if (spec.legend === true) {
			// Auto-detect: find first mark with a fill or stroke color field
			for (const m of spec.marks ?? []) {
				if ('fill' in m && m.fill && typeof m.fill === 'string') {
					return { color: m.fill };
				}
				if ('stroke' in m && m.stroke && typeof m.stroke === 'string') {
					return { color: m.stroke };
				}
			}
			return null;
		}
		return spec.legend;
	});

	const legendPosition = $derived(
		(typeof spec.legend === 'object' && spec.legend?.position) || 'top'
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
		useXSelection={spec.useXSelection ?? false}
		useYSelection={spec.useYSelection ?? false}
		{legendPosition}
	>
		{#snippet background()}
			<Frame />
			<AxisLeft />
			<AxisBottom />
			<MarginLabel />
		{/snippet}

		{#snippet canvas()}
			<WebGPUCanvas>
				{#snippet canvasComponents()}
					<Grid />
					{#each resolvedMarks as { component: MarkComponent, props }, i (i)}
						<MarkComponent {...props} />
					{/each}
				{/snippet}
			</WebGPUCanvas>
		{/snippet}

		{#snippet foreground()}
			<Crosshair />
		{/snippet}

		{#snippet interactors()}
			{#each spec.interactors ?? [] as interactor, i (i)}
				{#if interactor.interactor === 'intervalX'}
					<IntervalX bridge={bridge} field={interactor.field} />
				{:else if interactor.interactor === 'intervalY'}
					<IntervalY bridge={bridge} field={interactor.field} />
				{/if}
			{/each}
		{/snippet}

		{#snippet legend()}
			{#if legendConfig}
				<Legend
					color={legendConfig.color}
					title={legendConfig.title ?? null}
					columns={legendConfig.columns ?? null}
					swatchSize={legendConfig.swatchSize}
					swatchRadius={legendConfig.swatchRadius}
					orientation={legendConfig.orientation ?? null}
				/>
			{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.diveplot-spec-plot {
		position: relative;
	}
</style>
