<script>
	import { count } from '@uwdata/mosaic-sql';
	import { getContext } from 'svelte';
	import { ChartContainer, Grid, Crosshair, WebGPUCanvas, RectYMark } from '$lib/components';
	import { bin } from '$lib/sql/bin';

	const coordinator = getContext('mosaic-coordinator');

	// LOD rung diagnostics (polled periodically)
	let lodSurface = $state(null);
	let diagnostics = $state({
		binStep: 0,
		numVisibleBins: 0,
		binWidthPx: 0,
		multiplier: 1.0,
		frameCallbackCount: 0
	});

	$effect(() => {
		if (lodSurface) {
			const interval = setInterval(() => {
				const rungs = lodSurface.getRungs();
				const bins = rungs.find((r) => r.name === 'bins' && !r.destroyed);
				if (bins) {
					diagnostics = {
						binStep: bins.binStep,
						numVisibleBins: bins.numVisibleBins,
						binWidthPx: bins.binWidthPx,
						multiplier: (bins.props.multiplier) ?? 1.0,
						frameCallbackCount: bins.frameCallbackCount
					};
				}
			}, 100);
			return () => clearInterval(interval);
		}
	});
</script>

<div class="page">
	<h2>Binned LOD Rung Test</h2>
	<p class="description">
		AdaptiveBinRung: geometric metric derivation, adaptive re-binning, per-mark
		shift+scroll routing. Hover a bar and shift+scroll to adjust bin resolution.
	</p>

	<div class="layout">
		<div class="charts">
			<div class="chart-section">
				<h3>Histogram with AdaptiveBinRung (auto-created for binned marks)</h3>
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
										onMarkLOD={(surface) => {
											lodSurface = surface;
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
			<h3>AdaptiveBinRung Diagnostics</h3>
			{#if lodSurface}
				<table>
					<tbody>
						<tr><td>Bin Step</td><td>{diagnostics.binStep.toFixed(4)}</td></tr>
						<tr><td>Visible Bins</td><td>{diagnostics.numVisibleBins.toFixed(1)}</td></tr>
						<tr><td>Bin Width (px)</td><td>{diagnostics.binWidthPx.toFixed(1)}</td></tr>
						<tr><td>Multiplier</td><td>{diagnostics.multiplier.toFixed(3)}</td></tr>
						<tr><td>Frame Callbacks</td><td>{diagnostics.frameCallbackCount}</td></tr>
					</tbody>
				</table>
			{:else}
				<p class="no-data">No MarkLODSurface registered yet</p>
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
