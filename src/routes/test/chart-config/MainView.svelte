<script lang="ts">
	import { ChartContainer, DotsMark, WebGPUCanvas, Grid, Crosshair } from '$lib/components';
	import type { ChartConfig, MarkEntry } from '$lib/config';
	import ConfigCapture from './ConfigCapture.svelte';

	let mountCount = $state(0);
	let chartConfig: ChartConfig | null = $state(null);

	// Upstream prop — changes here should auto-clear palette overrides
	let upstreamOpacity = $state(0.5);

	let dotEntry: MarkEntry | null = $derived(
		chartConfig
			? ([...chartConfig.entries.values()].find((e) => e.markType === 'dot') ?? null)
			: null
	);
</script>

<div class="test-page">
	<h2>ChartConfig Phase 1 — Reactive Configuration Store</h2>

	<div class="controls">
		<div class="button-group">
			<span class="label">Fill:</span>
			<button
				onclick={() => dotEntry && chartConfig?.setMarkProp(dotEntry.id, 'fill', 'species')}
				disabled={!dotEntry}>Color by species</button
			>
			<button
				onclick={() => dotEntry && chartConfig?.setMarkProp(dotEntry.id, 'fill', 'island')}
				disabled={!dotEntry}>Color by island</button
			>
			<button
				onclick={() => dotEntry && chartConfig?.setMarkProp(dotEntry.id, 'fill', null)}
				disabled={!dotEntry}>Clear color</button
			>
		</div>
		<div class="button-group">
			<span class="label">Opacity:</span>
			<button
				onclick={() => dotEntry && chartConfig?.setMarkProp(dotEntry.id, 'opacity', 0.3)}
				disabled={!dotEntry}>0.3</button
			>
			<button
				onclick={() => dotEntry && chartConfig?.setMarkProp(dotEntry.id, 'opacity', 0.8)}
				disabled={!dotEntry}>0.8</button
			>
			<button
				onclick={() => dotEntry && chartConfig?.revertMarkProp(dotEntry.id, 'opacity')}
				disabled={!dotEntry}>Reset</button
			>
		</div>
		<div class="button-group">
			<span class="label">X scale:</span>
			<button
				onclick={() => dotEntry && chartConfig?.setMarkProp(dotEntry.id, 'preferredXScaleType', 'log')}
				disabled={!dotEntry}>Log</button
			>
			<button
				onclick={() => dotEntry && chartConfig?.setMarkProp(dotEntry.id, 'preferredXScaleType', 'symlog')}
				disabled={!dotEntry}>Symlog</button
			>
			<button
				onclick={() => dotEntry && chartConfig?.revertMarkProp(dotEntry.id, 'preferredXScaleType')}
				disabled={!dotEntry}>Reset</button
			>
		</div>
		<div class="button-group">
			<span class="label">Y scale:</span>
			<button
				onclick={() => dotEntry && chartConfig?.setMarkProp(dotEntry.id, 'preferredYScaleType', 'log')}
				disabled={!dotEntry}>Log</button
			>
			<button
				onclick={() => dotEntry && chartConfig?.setMarkProp(dotEntry.id, 'preferredYScaleType', 'symlog')}
				disabled={!dotEntry}>Symlog</button
			>
			<button
				onclick={() => dotEntry && chartConfig?.revertMarkProp(dotEntry.id, 'preferredYScaleType')}
				disabled={!dotEntry}>Reset</button
			>
		</div>
		<div class="button-group">
			<span class="label">Upstream prop:</span>
			<button onclick={() => (upstreamOpacity = 0.2)}>Set opacity=0.2</button>
			<button onclick={() => (upstreamOpacity = 0.7)}>Set opacity=0.7</button>
			<button onclick={() => (upstreamOpacity = 0.5)}>Set opacity=0.5</button>
		</div>
		<div class="button-group">
			<span class="label">Actions:</span>
			<button
				onclick={() => dotEntry && chartConfig?.revertMark(dotEntry.id)}
				disabled={!dotEntry}>Revert all</button
			>
		</div>
	</div>

	<div class="diagnostics">
		<span>Mount count: <strong>{mountCount}</strong></span>
		<span>Entry fill: <strong>{dotEntry?.fill ?? 'null'}</strong></span>
		<span>Upstream opacity: <strong>{upstreamOpacity}</strong></span>
		<span>Entry opacity: <strong>{dotEntry?.opacity ?? 'n/a'}</strong></span>
		<span>X scale: <strong>{dotEntry?.preferredXScaleType ?? 'auto'}</strong></span>
		<span>Y scale: <strong>{dotEntry?.preferredYScaleType ?? 'auto'}</strong></span>
		<span>Registered marks: <strong>{chartConfig?.entries.size ?? 0}</strong></span>
	</div>

	<div class="chart-container">
		<ChartContainer xLabel="bill_length" yLabel="body_mass">
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<DotsMark table="penguins" x="bill_length" y="body_mass" r={3} opacity={upstreamOpacity} />
						<ConfigCapture
							onConfig={(cfg) => (chartConfig = cfg)}
							onMounted={() => mountCount++}
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
			{#snippet foreground()}
				<Crosshair />
			{/snippet}
		</ChartContainer>
	</div>
</div>

<style>
	.test-page {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	h2 {
		margin: 0;
		font-size: 1.2rem;
	}
	.controls {
		display: flex;
		gap: 1.5rem;
		flex-wrap: wrap;
	}
	.button-group {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.label {
		font-weight: 600;
		font-size: 0.85rem;
		color: #666;
	}
	button {
		padding: 0.3rem 0.75rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
		font-size: 0.85rem;
	}
	button:hover:not(:disabled) {
		background: #f0f0f0;
	}
	button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.diagnostics {
		display: flex;
		gap: 1.5rem;
		font-size: 0.85rem;
		color: #555;
		padding: 0.5rem;
		background: #f8f8f8;
		border-radius: 4px;
	}
	.chart-container {
		height: 400px;
	}
</style>
