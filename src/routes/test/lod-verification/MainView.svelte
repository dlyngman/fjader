<script>
	import { getContext } from 'svelte';
	import { ChartContainer, Grid, Crosshair, WebGPUCanvas, LineMark } from '$lib/components';
	import { IntervalX } from '$lib/interactors';

	const coordinator = getContext('mosaic-coordinator');

	// Diagnostic state from the LOD controller
	let lodState = $state({
		visibleCount: 0,
		queryLatencyMs: 0,
		timeSinceLastQuery: 0,
		dotRadius: 0,
		shouldDecimate: false,
		density: 0,
		frameCallbackCount: 0,
		queriesIssued: 0
	});

	// Poll LOD controller state (registered via onLodController callback)
	let lodRef = $state(null);

	$effect(() => {
		if (lodRef) {
			const interval = setInterval(() => {
				lodState = {
					visibleCount: lodRef.visibleCount,
					queryLatencyMs: lodRef.queryLatencyMs,
					timeSinceLastQuery: lodRef.timeSinceLastQuery,
					dotRadius: lodRef.dotRadius,
					shouldDecimate: lodRef.shouldDecimate,
					density: lodRef.density,
					frameCallbackCount: lodRef.frameCallbackCount,
					queriesIssued: lodRef.queriesIssued
				};
			}, 100);
			return () => clearInterval(interval);
		}
	});
</script>

<div class="main-view-container">
	<h2>LOD Architecture Verification</h2>
	<p>
		100K points (33K per series). Compare GPU-driven auto-dots (reference) vs JS-driven LOD
		controller. Chart 4 brushes crossfilter into charts 2+3.
	</p>

	<div class="charts-grid">
		<div class="chart-wrapper">
			<h3>1. Reference (GPU auto-dots)</h3>
			<ChartContainer xLabel="x" yLabel="y" xZoomLimit={10000} yZoomLimit={10000}>
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="dense_timeseries"
								x="x"
								y="y"
								stroke="series"
								strokeWidth={1.5}
								dotRadius={4}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<div class="chart-wrapper">
			<h3>2. LOD Controller (JS dots + JS M4 decision)</h3>
			<ChartContainer xLabel="x" yLabel="y" xZoomLimit={10000} yZoomLimit={10000}>
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="dense_timeseries"
								x="x"
								y="y"
								stroke="series"
								strokeWidth={1.5}
								dotRadius={4}
								lod={true}
								selection="lod-brush"
								onLodController={(ctrl) => (lodRef = ctrl)}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<div class="chart-wrapper">
			<h3>3. LOD Controller (JS dots, no M4)</h3>
			<ChartContainer xLabel="x" yLabel="y" xZoomLimit={10000} yZoomLimit={10000}>
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="dense_timeseries"
								x="x"
								y="y"
								stroke="series"
								strokeWidth={1.5}
								dotRadius={4}
								lod={{ decimate: false }}
								selection="lod-brush"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<div class="chart-wrapper">
			<h3>4. Crossfilter source (brush here to filter charts 2+3)</h3>
			<ChartContainer xLabel="x" yLabel="y">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark table="dense_timeseries" x="x" y="y" stroke="series" strokeWidth={1.5} />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}

				{#snippet interactors()}
					<IntervalX selection="lod-brush" />
				{/snippet}
			</ChartContainer>
		</div>
	</div>

	<div class="diagnostics">
		<h3>LOD Diagnostics (Chart 2)</h3>
		<div class="diagnostic-grid">
			<div class="metric">
				<span class="label">Visible Count</span>
				<span class="value">{lodState.visibleCount.toLocaleString()}</span>
			</div>
			<div class="metric">
				<span class="label">Query Latency</span>
				<span class="value">{lodState.queryLatencyMs.toFixed(1)}ms</span>
			</div>
			<div class="metric">
				<span class="label">Since Last Query</span>
				<span class="value">{lodState.timeSinceLastQuery.toFixed(0)}ms</span>
			</div>
			<div class="metric">
				<span class="label">Queries Issued</span>
				<span class="value">{lodState.queriesIssued}</span>
			</div>
			<div class="metric">
				<span class="label">Frame Callbacks</span>
				<span class="value">{lodState.frameCallbackCount}</span>
			</div>
			<div class="metric">
				<span class="label">Density (pts/px)</span>
				<span class="value">{lodState.density.toFixed(2)}</span>
			</div>
			<div class="metric">
				<span class="label">Dot Radius</span>
				<span class="value">{lodState.dotRadius.toFixed(2)}px</span>
			</div>
			<div class="metric">
				<span class="label">Should Decimate</span>
				<span class="value" class:active={lodState.shouldDecimate}>
					{lodState.shouldDecimate ? 'YES (JS)' : 'NO (JS)'}
				</span>
			</div>
		</div>
	</div>
</div>

<style>
	.main-view-container {
		width: 100%;
		padding: 20px;
	}

	h2 {
		margin-bottom: 10px;
	}

	p {
		margin-bottom: 20px;
		color: #666;
	}

	.charts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
		gap: 20px;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 300px;
		max-height: 500px;
	}

	h3 {
		margin-bottom: 10px;
		font-size: 14px;
		color: #333;
	}

	.diagnostics {
		margin-top: 30px;
		padding: 16px;
		background: #f5f5f5;
		border-radius: 8px;
	}

	.diagnostics h3 {
		margin-bottom: 12px;
		color: #333;
	}

	.diagnostic-grid {
		display: flex;
		gap: 24px;
		flex-wrap: wrap;
	}

	.metric {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.label {
		font-size: 11px;
		text-transform: uppercase;
		color: #888;
		letter-spacing: 0.05em;
	}

	.value {
		font-size: 18px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: #333;
	}

	.value.active {
		color: #e44;
	}
</style>
