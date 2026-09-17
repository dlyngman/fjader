<!-- src/routes/transform-test/+page.svelte -->
<script>
	import { onMount } from 'svelte';
	import { loadParquet, sum, count, avg, gt } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import { ChartContainer, DotsMark, WebGPUCanvas, BarMarkX, RectXMark } from '$lib/components';
	import { filter, topN, normalize, stack } from '$lib/transforms';
	import { bin } from '$lib/sql/bin';

	const { queryEngine } = initDivePlot();
	let isLoaded = $state(false);

	onMount(async () => {
		await queryEngine.exec(
			loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString()
		);
		isLoaded = true;
	});
</script>

<div class="container">
	<h1>✅ Transform Pipeline Working!</h1>

	{#if !isLoaded}
		<p>Loading...</p>
	{:else}
		<!-- <div class="chart-section">
			<h2>All Penguins (binned)</h2>
			<p>Should show ~12 bins</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length_bin" yLabel="count">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<DotsMark
									table="penguins"
									selection="brush"
									x={bin('bill_length', { step: 5 })}
									y={count()}
									fill="species"
									r={12}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>
		</div> -->

		<!-- <div class="chart-section">
			<h2>Heavy Penguins Only (body_mass > 4500)</h2>
			<p>Should show fewer bins (lighter penguins filtered out)</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length_bin" yLabel="count">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<DotsMark
									table="penguins"
									selection="brush"
									x={bin('bill_length', { step: 5 })}
									y={count()}
									fill="species"
									r={8}
									transforms={[filter(gt('body_mass', 4500))]}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>
		</div> -->

		<!-- <div class="chart-section">
			<h2>Very Heavy Penguins (body_mass > 5000)</h2>
			<p>Should show even fewer bins</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length_bin" yLabel="count">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<DotsMark
									table="penguins"
									selection="brush"
									x={bin('bill_length', { step: 5 })}
									y={count()}
									fill="species"
									r={8}
									transforms={[filter(gt('body_mass', 5000))]}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>
		</div> -->

		<!-- <div class="chart-section">
			<h2>Top 5 Bins</h2>
			<p>
				Should show only the top 5 bins by count. No Other bucket: a binned axis has no dim to
				reserve an Other id in.
			</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length_bin" yLabel="count">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<DotsMark
									table="penguins"
									selection="brush"
									x={bin('bill_length', { step: 5 })}
									y={count()}
									fill="species"
									opacity="1"
									r={12}
									transforms={[topN(5)]}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>
		</div> -->

		<!-- <div class="chart-section">
			<h2>Normalized Bins (JS Transform)</h2>
			<p>Each bin shows percentage of total</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="count" yLabel="body_mass">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<DotsMark
									table="penguins"
									selection="brush"
									x={bin('bill_length', { step: 5 })}
									y={count()}
									fill="species"
									r={8}
									opacity="1"
									transforms={[normalize()]}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>
		</div> -->

		<div class="chart-section">
			<h2>Stacked binned histogram</h2>
			<p>
				Species stacked along x within each body_mass bin. The fill channel is what makes stack() do
				anything: without it there is one row per bin, the cumulative sum equals that row's own
				value, and the result is an ordinary histogram.
			</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="count" yLabel="body_mass">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<RectXMark
									table="penguins"
									selection="brush"
									y={bin('body_mass', { step: 500 })}
									x={count()}
									fill="species"
									transforms={[stack({ direction: 'horizontal' })]}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	{/if}
</div>

<style>
	.container {
		padding: 2rem;
	}
	.chart-section {
		margin-bottom: 2rem;
		border: 1px solid #ccc;
		padding: 1rem;
		/* height: 400px; */
		width: 100%;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 200px;
		max-height: 200px;
		position: relative;
	}

	h2 {
		margin-top: 0;
	}
	p {
		color: #666;
		font-style: italic;
		margin: 0.5rem 0 1rem 0;
	}
</style>
