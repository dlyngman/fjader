<script>
	import { min, avg, count } from '@uwdata/mosaic-sql';
	import { getContext } from 'svelte';
	import {
		ChartContainer,
		Grid,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		DotsMark
	} from '$lib/components';

	// Toggle SVG layers to isolate jank source — judge VISUALLY, not by metrics
	let showAxes = $state(true);
	let showGrid = $state(true);
	let showFrame = $state(true);
	let showCrosshair = $state(true);
</script>

<div style="padding: 1rem; font-family: system-ui;">
	<h2>Jank Isolation — Real rendering pipeline, toggleable SVG</h2>
	<p style="color: #666; font-size: 13px;">
		Zoom with wheel. Toggle layers off one at a time. Judge smoothness VISUALLY.
	</p>

	<div
		style="display: flex; gap: 16px; margin: 12px 0; padding: 8px 12px; background: #f5f5f5; border-radius: 6px; font-size: 14px;"
	>
		<label><input type="checkbox" bind:checked={showAxes} /> Axes</label>
		<label><input type="checkbox" bind:checked={showGrid} /> Grid</label>
		<label><input type="checkbox" bind:checked={showFrame} /> Frame</label>
		<label><input type="checkbox" bind:checked={showCrosshair} /> Crosshair</label>
	</div>
</div>

<div class="chart-wrapper">
	<ChartContainer xLabel={'delay'} yLabel={'time'}>
		{#snippet background()}
			{#if showFrame}<Frame />{/if}
			{#if showAxes}<AxisLeft />{/if}
			{#if showAxes}<AxisBottom />{/if}
			{#if showAxes}<MarginLabel />{/if}
		{/snippet}

		{#snippet canvas()}
			<WebGPUCanvas>
				{#snippet canvasComponents()}
					{#if showGrid}<Grid />{/if}
					<DotsMark table="flights" x={min('delay')} y={'time'} color={avg('delay')} alpha="0.8" />
				{/snippet}
			</WebGPUCanvas>
		{/snippet}

		{#snippet foreground()}
			{#if showCrosshair}<Crosshair />{/if}
		{/snippet}
	</ChartContainer>
</div>

<style>
	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 200px;
		max-height: 600px;
	}
</style>
