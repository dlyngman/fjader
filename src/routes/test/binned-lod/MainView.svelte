<script>
	import { count } from '@uwdata/mosaic-sql';
	import { getContext } from 'svelte';
	import { ChartContainer, Grid, Crosshair, WebGPUCanvas, RectYMark } from '$lib/components';
	import { bin } from '$lib/sql/bin';

	const coordinator = getContext('mosaic-coordinator');

	// LOD controller diagnostics (polled periodically)
	let lodRef = $state(null);
	let diagnostics = $state({
		mode: '',
		binStep: 0,
		numVisibleBins: 0,
		binWidthPx: 0,
		density: 0,
		frameCallbackCount: 0
	});

	$effect(() => {
		if (lodRef) {
			const interval = setInterval(() => {
				diagnostics = {
					mode: lodRef.mode,
					binStep: lodRef.binStep,
					numVisibleBins: lodRef.numVisibleBins,
					binWidthPx: lodRef.binWidthPx,
					density: lodRef.density,
					frameCallbackCount: lodRef.frameCallbackCount
				};
			}, 100);
			return () => clearInterval(interval);
		}
	});
</script>

<div class="page">
	<h2>Binned LOD Controller Test</h2>
	<p class="description">
		LODController in binned mode: geometric metric derivation, adaptive re-binning, per-mark
		shift+scroll routing. Hover a bar and shift+scroll to adjust bin resolution.
	</p>

	<div class="layout">
		<div class="charts">
			<div class="chart-section">
				<h3>Histogram with LOD (auto-created for binned marks)</h3>
				<div class="chart-wrapper">
					<ChartContainer xLabel="value" yLabel="count">
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<RectYMark
										table="histogram_data"
										x={bin('value', { steps: 50 })}
										y2={count()}
										fill="steelblue"
										onLodController={(ctrl) => {
											lodRef = ctrl;
										}}
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
		</div>

		<div class="diagnostics">
			<h3>LOD Controller Diagnostics</h3>
			{#if lodRef}
				<table>
					<tbody>
						<tr><td>Mode</td><td>{diagnostics.mode}</td></tr>
						<tr><td>Bin Step</td><td>{diagnostics.binStep.toFixed(4)}</td></tr>
						<tr><td>Visible Bins</td><td>{diagnostics.numVisibleBins.toFixed(1)}</td></tr>
						<tr><td>Bin Width (px)</td><td>{diagnostics.binWidthPx.toFixed(1)}</td></tr>
						<tr><td>Density (bins/px)</td><td>{diagnostics.density.toFixed(6)}</td></tr>
						<tr><td>Frame Callbacks</td><td>{diagnostics.frameCallbackCount}</td></tr>
					</tbody>
				</table>
			{:else}
				<p class="no-data">No LODController registered yet</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.page {
		max-width: 1200px;
		margin: 0 auto;
		padding: 20px;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
	}

	h2 {
		margin: 0 0 8px 0;
		font-size: 20px;
	}

	h3 {
		margin: 0 0 8px 0;
		font-size: 14px;
		font-weight: 600;
	}

	.description {
		margin: 0 0 20px 0;
		color: #666;
		font-size: 13px;
	}

	.layout {
		display: flex;
		gap: 20px;
	}

	.charts {
		flex: 1;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 300px;
		max-height: 500px;
		position: relative;
		border: 1px solid #ddd;
		border-radius: 8px;
		overflow: hidden;
	}

	.diagnostics {
		width: 260px;
		flex-shrink: 0;
	}

	.diagnostics table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
		font-family: monospace;
	}

	.diagnostics td {
		padding: 4px 8px;
		border-bottom: 1px solid #eee;
	}

	.diagnostics td:first-child {
		font-weight: 600;
		white-space: nowrap;
	}

	.diagnostics td:last-child {
		text-align: right;
	}

	.no-data {
		color: #999;
		font-size: 12px;
		font-style: italic;
	}
</style>
