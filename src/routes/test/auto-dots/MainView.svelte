<script>
	import { getContext } from 'svelte';
	import {
		ChartContainer,
		Grid,
		Crosshair,
		WebGPUCanvas,
		LineMark,
		AreaMarkY
	} from '$lib/components';

	const configs = [
		{
			label: 'LineMark + LOD dots (default 2.5px)',
			mark: 'line',
			lod: true,
			autoDots: false,
			dotRadius: 0,
			strokeWidth: 1.5
		},
		{
			label: 'LineMark + LOD dots + dotRadius=4',
			mark: 'line',
			lod: true,
			autoDots: false,
			dotRadius: 4,
			strokeWidth: 1.5
		},
		{
			label: 'AreaMarkY + autoDots',
			mark: 'area',
			lod: false,
			autoDots: true,
			dotRadius: 0,
			fillOpacity: 0.4
		},
		{
			label: 'LineMark + dotRadius=3 (always visible)',
			mark: 'line',
			lod: false,
			autoDots: false,
			dotRadius: 3,
			strokeWidth: 1.5
		},
		{
			label: 'LineMark without dots (baseline)',
			mark: 'line',
			lod: false,
			autoDots: false,
			dotRadius: 0,
			strokeWidth: 1.5
		}
	];

	let selected = $state([0, 4]);
</script>

<div class="container">
	<h2>Auto-Dots Test</h2>
	<p>Zoom in to see dots appear. Zoomed out = smooth lines, no dots.</p>

	{#each [0, 1] as idx (idx)}
		{@const config = configs[selected[idx]]}
		<div class="chart-section">
			<select bind:value={selected[idx]}>
				{#each configs as cfg, i (i)}
					<option value={i}>{cfg.label}</option>
				{/each}
			</select>

			{#key selected[idx]}
				<div class="chart-wrapper">
					<ChartContainer xLabel="x" yLabel="y" xZoomLimit={10000} yZoomLimit={10000}>
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									{#if config.mark === 'area'}
										<AreaMarkY
											table="dense_timeseries"
											x="x"
											y="y"
											fill="series"
											fillOpacity={config.fillOpacity ?? 0.4}
											autoDots={config.autoDots}
											dotRadius={config.dotRadius}
										/>
									{:else}
										<LineMark
											table="dense_timeseries"
											x="x"
											y="y"
											stroke="series"
											strokeWidth={config.strokeWidth ?? 1.5}
											lod={config.lod}
											dotRadius={config.dotRadius}
										/>
									{/if}
								{/snippet}
							</WebGPUCanvas>
						{/snippet}

						{#snippet foreground()}
							<Crosshair />
						{/snippet}
					</ChartContainer>
				</div>
			{/key}
		</div>
	{/each}
</div>

<style>
	.container {
		width: 100%;
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	h2 {
		margin: 0;
	}

	p {
		margin: 0;
		color: #666;
	}

	.chart-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	select {
		width: fit-content;
		padding: 4px 8px;
		font-size: 14px;
		border: 1px solid #ccc;
		border-radius: 4px;
	}

	.chart-wrapper {
		width: 100%;
		height: 45vh;
		min-height: 250px;
	}
</style>
