<!-- src/routes/transform-test/+page.svelte -->
<script>
	import { onMount } from 'svelte';
	import { Selection } from '@uwdata/mosaic-core';
	import { loadParquet, sum, count, avg, gt } from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { ChartContainer, DotsMark, WebGPUCanvas, BarMarkX } from '$lib/components';
	import { filter, topN, normalize, stack } from '$lib/transforms';
	import { bin } from '$lib/sql/bin';

	import Plot from './Plot.svelte';

	import { setQueryContext, initDuckDB } from '$lib/query-engine';
	const brushSeletion = Selection.crossfilter();

	setCoordinators();

	const { queryEngine } = setQueryContext(initDuckDB());
	let isLoaded = $state(false);

	onMount(async () => {
		await queryEngine.exec(loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString());
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
									selection={brushSeletion}
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
									selection={brushSeletion}
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
									selection={brushSeletion}
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
			<h2>Top 5 Bins + Other (JS Transform)</h2>
			<p>Should show only 6 points: top 5 bins by count + "Other"</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length_bin" yLabel="count">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<DotsMark
									table="penguins"
									selection={brushSeletion}
									x={bin('bill_length', { step: 5 })}
									y={count()}
									fill="species"
									opacity="1"
									r={12}
									transforms={[topN(5, { includeOthers: true })]}
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
				<ChartContainer xLabel="bill_length_bin" yLabel="percentage">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<DotsMark
									table="penguins"
									selection={brushSeletion}
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
			<h2>Bar</h2>
			<p>Stacked</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length_bin" yLabel="percentage">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<BarMarkX
									table="penguins"
									selection={brushSeletion}
									y={bin('body_mass', { step: 500 })}
									x={count()}
									transforms={[stack({ direction: 'horizontal' })]}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>
		</div>

		<div class="chart-section">
			<Plot selection={brushSeletion} />
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
