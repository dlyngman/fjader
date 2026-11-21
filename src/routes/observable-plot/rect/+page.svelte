<script>
	import * as msql from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		RectYMark,
		RectXMark,
		RectMark,
		Legend
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import { bin } from '$lib/sql/bin';
	import { filter } from '$lib/transforms';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec([
				msql.loadCSV('olympians', `${window.location.origin}/data/olympians.csv`).toString(),
				msql.loadCSV('diamonds', `${window.location.origin}/data/diamonds.csv`).toString()
			]);

			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

{#if loadError}
	<p class="status error">Error loading data: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading...</p>
{:else}
	<div class="container">
		<h1>Histogram</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer yLabel="Count" xLabel="Weight (kg)">
					<Frame />
					<AxisLeft />
					<AxisBottom />
					<MarginLabel />

					<Grid />
					<RectYMark table="olympians" x={bin('weight')} y={msql.count()} />

					<Crosshair />
				</ChartContainer>
			</div>
		</div>
	</div>

	<div class="container">
		<h1>Stacked Histogram</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer yLabel="Count (stacked)" xLabel="Weight (kg, stacked)">
					<Legend color="sex" />
					<Frame />
					<AxisLeft />
					<AxisBottom />
					<MarginLabel />

					<Grid />
					<RectYMark table="olympians" x={bin('weight')} y={msql.count()} fill="sex" />

					<Crosshair />
				</ChartContainer>
			</div>
		</div>
	</div>

	<div class="container">
		<h1>Horizontal Histogram</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer xLabel="Count (horizontal)" yLabel="Weight (kg, horizontal)">
					<Frame />
					<AxisLeft />
					<AxisBottom />
					<MarginLabel />

					<Grid />
					<RectXMark table="olympians" y={bin('weight')} x={msql.count()} />

					<Crosshair />
				</ChartContainer>
			</div>
		</div>
	</div>

	<div class="container">
		<h1>2D Histogram (heatmap)</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer yLabel="Price" xLabel="Carat">
					<Frame />
					<AxisLeft />
					<AxisBottom />
					<MarginLabel />

					<Grid />
					<RectMark
						table="diamonds"
						x={bin('carat', { steps: 100 })}
						y={bin('price', { steps: 100 })}
						fill={{ field: msql.count(), type: 'symlog' }}
						scheme="turbo"
						inset={0.5}
					/>

					<Crosshair />
				</ChartContainer>
			</div>
		</div>
	</div>

	<div class="container">
		<h1>Overlapping Histograms</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer yLabel="Count (overlapping)" xLabel="Weight (kg, overlapping)">
					<Legend color="sex" />
					<Frame />
					<AxisLeft />
					<AxisBottom />
					<MarginLabel />

					<Grid />
					<RectYMark
						table="olympians"
						x={bin('weight')}
						y2={msql.count()}
						fill="sex"
						opacity={0.5}
					/>

					<Crosshair />
				</ChartContainer>
			</div>
		</div>
	</div>
{/if}

<style>
	.container {
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}

	h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0 0 1.5rem 0;
	}

	.charts {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4 / 3;
		min-height: 300px;
		max-height: 600px;
		position: relative;
	}

	.status {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		font-size: 1rem;
		color: #666;
		margin: 0;
	}

	.error {
		color: red;
	}
</style>
