<script>
	import {
		ChartContainer,
		Frame,
		Grid,
		AxisLeft,
		AxisBottom,
		ParallelAxes,
		ParallelBrushes,
		WebGPUCanvas,
		DotsMark,
		ParallelCoordinatesMark
	} from '$lib/components';

	// Column removal test: drop the second axis and bring it back. Brush an
	// axis after it first, to see whether its brush stays on that axis.
	const ALL_COLUMNS = ['bill_length', 'bill_depth', 'flipper_length', 'body_mass'];
	let dropDepth = $state(false);
	const columns = $derived(dropDepth ? ALL_COLUMNS.filter((c) => c !== 'bill_depth') : ALL_COLUMNS);
</script>

<div class="main-view-container">
	<h2>Parallel Coordinates Test</h2>
	<p>Zoom/pan the scatter plot — the parallel coordinates "bill_length" axis should stay in sync</p>

	<div class="charts-grid">
		<div class="chart-wrapper">
			<h3>Parallel Coordinates ({columns.length} axes)</h3>
			<button onclick={() => (dropDepth = !dropDepth)}>
				{dropDepth ? 'Restore bill_depth' : 'Remove bill_depth'}
			</button>
			<span>columns: {columns.join(', ')}</span>
			<ChartContainer clipPadding={30}>
				{#snippet background()}
					<Frame />
					<ParallelAxes />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<ParallelCoordinatesMark
								table="penguins"
								{columns}
								stroke="species"
								opacity={0.5}
								curve="bump-x"
								selection="brush"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet interactors()}
					<ParallelBrushes selection="brush" />
				{/snippet}
			</ChartContainer>
		</div>

		<div class="chart-wrapper">
			<h3>Scatter Plot (bill_length x bill_depth — shared scales)</h3>
			<ChartContainer xLabel="bill_length" yLabel="bill_depth">
				{#snippet background()}
					<Frame />
				{/snippet}

				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<DotsMark
								table="penguins"
								x="bill_length"
								y="bill_depth"
								fill="species"
								selection="brush"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<AxisLeft />
					<AxisBottom />
				{/snippet}
			</ChartContainer>
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
</style>
