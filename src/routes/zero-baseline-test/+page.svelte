<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { sum } from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import {
		ChartContainer,
		WebGPUCanvas,
		BarMarkY,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';

	setCoordinators();

	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			const wasm = wasmConnector();
			const coord = new Coordinator();
			coord.databaseConnector(wasm);

			setContext('mosaic-coordinator', coord);

			// Create test data tables in DuckDB
			await coord.exec([
				// Test 1: Negative-only values (losses)
				`CREATE TABLE losses AS SELECT * FROM (VALUES
					('Q1', -50),
					('Q2', -30),
					('Q3', -45),
					('Q4', -25)
				) AS t(category, amount)`,

				// Test 2: Mixed positive/negative values (profit/loss)
				`CREATE TABLE profit_loss AS SELECT * FROM (VALUES
					('Q1', -20),
					('Q2', 15),
					('Q3', -10),
					('Q4', 30)
				) AS t(quarter, value)`,

				// Test 3: Positive-only for comparison
				`CREATE TABLE revenue AS SELECT * FROM (VALUES
					('North', 100),
					('South', 150),
					('East', 80),
					('West', 120)
				) AS t(region, sales)`
			]);

			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<svelte:head>
	<title>Zero Baseline Test - DivePlot</title>
</svelte:head>

<div class="app-container">
	{#if loadError}
		<div class="loading-container">Error loading data: {loadError}</div>
	{:else if !isLoaded}
		<div class="loading-container">Loading test data...</div>
	{:else}
		<div class="test-container">
			<h1>Zero Baseline Test for Aggregates</h1>
			<p class="subtitle">
				Testing that bar charts with aggregates correctly include zero in the domain for negative,
				positive, and mixed values.
			</p>

			<div class="test-grid">
				<!-- Test 1: Negative-only aggregates -->
				<div class="test-case">
					<h2>Test 1: Negative-only aggregates</h2>
					<p class="description">
						Loss amounts (all negative). Domain should be approximately [-50, 0].
					</p>
					<div class="chart">
						<ChartContainer xLabel="category" yLabel="loss amount">
							{#snippet background()}
								<Frame />
								<AxisLeft />
								<AxisBottom />
								<MarginLabel />
							{/snippet}

							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<Grid axis="y" />
										<BarMarkY
											table="losses"
											x="category"
											y={sum('amount')}
											color="steelblue"
											alpha={0.8}
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
					<p class="expected">✅ Expected: Y-axis from ~[-50, 0]</p>
				</div>

				<!-- Test 2: Mixed positive/negative aggregates -->
				<div class="test-case">
					<h2>Test 2: Mixed positive/negative</h2>
					<p class="description">
						Profit/loss by quarter (mixed signs). Domain should include zero and span both
						directions.
					</p>
					<div class="chart">
						<ChartContainer xLabel="quarter" yLabel="profit/loss">
							{#snippet background()}
								<Frame />
								<AxisLeft />
								<AxisBottom />
								<MarginLabel />
							{/snippet}

							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<BarMarkY
											table="profit_loss"
											x="quarter"
											y={sum('value')}
											color="orange"
											alpha={0.8}
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
					<p class="expected">✅ Expected: Y-axis from ~[-30, 30] with zero visible</p>
				</div>

				<!-- Test 3: Positive-only (standard case) -->
				<div class="test-case">
					<h2>Test 3: Positive-only (baseline)</h2>
					<p class="description">
						Revenue by region (all positive). Domain should be [0, max] as before.
					</p>
					<div class="chart">
						<ChartContainer xLabel="region" yLabel="sales">
							{#snippet background()}
								<Frame />
								<AxisLeft />
								<AxisBottom />
								<MarginLabel />
							{/snippet}

							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<BarMarkY
											table="revenue"
											x="region"
											y={sum('sales')}
											color="green"
											alpha={0.8}
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
					<p class="expected">✅ Expected: Y-axis from [0, ~150]</p>
				</div>
			</div>

			<div class="notes">
				<h3>Test Notes</h3>
				<ul>
					<li>
						<strong>Negative-only:</strong> The bug fix ensures the domain extends to 0 on the positive
						side (Math.max(0, extent[1]))
					</li>
					<li>
						<strong>Mixed values:</strong> Zero is guaranteed to be within the domain bounds, providing
						visual reference for positive vs negative
					</li>
					<li>
						<strong>Positive-only:</strong> Standard behavior, domain starts at 0 as expected (Math.min(0,
						extent[0]))
					</li>
					<li>
						All three cases use <code>sum()</code> aggregates, which trigger automatic zero baseline
						detection
					</li>
				</ul>
			</div>
		</div>
	{/if}
</div>

<style>
	.app-container {
		width: 100%;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.loading-container {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 200px;
		padding: 2rem;
	}

	.test-container {
		padding: 2rem;
		max-width: 1600px;
		margin: 0 auto;
	}

	h1 {
		margin-bottom: 0.5rem;
	}

	.subtitle {
		color: #666;
		margin-bottom: 2rem;
		line-height: 1.6;
	}

	.test-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(450px, 1fr));
		gap: 2rem;
		margin-bottom: 2rem;
	}

	.test-case {
		border: 1px solid #ddd;
		border-radius: 8px;
		padding: 1.5rem;
		background: white;
	}

	.test-case h2 {
		margin-top: 0;
		margin-bottom: 0.5rem;
		font-size: 1.2rem;
		color: #333;
	}

	.description {
		color: #666;
		font-size: 0.9rem;
		margin-bottom: 1rem;
		line-height: 1.5;
	}

	.chart {
		width: 100%;
		aspect-ratio: 4/3;
		margin-bottom: 1rem;
	}

	.expected {
		background: #f0f9ff;
		padding: 0.75rem;
		border-radius: 4px;
		font-size: 0.9rem;
		margin: 0;
		border-left: 3px solid #3b82f6;
	}

	.notes {
		background: #fef3c7;
		padding: 1.5rem;
		border-radius: 8px;
		border-left: 4px solid #f59e0b;
	}

	.notes h3 {
		margin-top: 0;
		margin-bottom: 1rem;
		color: #92400e;
	}

	.notes ul {
		margin: 0;
		padding-left: 1.5rem;
	}

	.notes li {
		margin-bottom: 0.5rem;
		line-height: 1.6;
	}

	.notes code {
		background: #fde68a;
		padding: 0.125rem 0.375rem;
		border-radius: 3px;
		font-family: 'Courier New', monospace;
		font-size: 0.9em;
	}

	@media (max-width: 768px) {
		.test-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
