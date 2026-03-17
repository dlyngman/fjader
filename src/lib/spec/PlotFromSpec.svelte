<script lang="ts">
	import ChartContainer from '$lib/components/charts/ChartContainer.svelte';
	import WebGPUCanvas from '$lib/components/rendering/WebGPUCanvas.svelte';
	import { AxisBottom, AxisLeft, MarginLabel } from '$lib/components/axes';
	import Frame from '$lib/components/background/Frame.svelte';
	import { Grid } from '$lib/components/guides';
	import Crosshair from '$lib/components/foreground/Crosshair.svelte';
	import Legend from '$lib/components/guides/legend/Legend.svelte';
	import IntervalX from '$lib/interactors/IntervalX.svelte';
	import IntervalY from '$lib/interactors/IntervalY.svelte';
	import Interval2D from '$lib/interactors/Interval2D.svelte';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import DerivedIntervalX from '$lib/interactors/DerivedIntervalX.svelte';
	import { resolveMarkEntry } from './MarkRegistry';
	import type { LegendSpec, PlotSpec } from './types';

	interface Props {
		spec: PlotSpec;
	}

	let { spec }: Props = $props();

	// Derive selection name from the first mark that declares one.
	// Interactors and legend share the same selection group.
	const selectionName = $derived.by((): string | null => {
		for (const m of spec.marks ?? []) {
			if (typeof m.selection === 'string') return m.selection;
		}
		return null;
	});

	const resolvedMarks = $derived((spec.marks ?? []).map((markSpec) => resolveMarkEntry(markSpec)));

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
		xZoomLimit={spec.xZoomLimit}
		yZoomLimit={spec.yZoomLimit}
		xPanLimit={spec.xPanLimit}
		yPanLimit={spec.yPanLimit}
		xDisableZoom={spec.xDisableZoom}
		yDisableZoom={spec.yDisableZoom}
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
					<IntervalX
						selection={interactor.selection ?? selectionName ?? undefined}
						field={interactor.field}
					/>
				{:else if interactor.interactor === 'intervalY'}
					<IntervalY
						selection={interactor.selection ?? selectionName ?? undefined}
						field={interactor.field}
					/>
				{:else if interactor.interactor === 'interval2D'}
					<Interval2D
						selection={interactor.selection ?? selectionName ?? undefined}
						xField={interactor.xField}
						yField={interactor.yField}
					/>
				{:else if interactor.interactor === 'toggle'}
					<Toggle
						selection={interactor.selection ?? selectionName ?? undefined}
						field={interactor.field}
					/>
				{:else if interactor.interactor === 'derivedInterval'}
					<DerivedIntervalX
						sourceSelection={interactor.source}
						selection={interactor.selection}
						offset={interactor.offset}
					/>
				{/if}
			{/each}
		{/snippet}

		{#snippet legend()}
			{#if legendConfig}
				<Legend
					color={legendConfig.color}
					selection={legendConfig.selection ?? selectionName ?? undefined}
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
