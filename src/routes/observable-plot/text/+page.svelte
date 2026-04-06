<script>
	import * as msql from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		BarMarkX,
		DotsMark,
		LineMark,
		TextMark
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';

	import { setQueryContext, initDuckDB } from '$lib/query-engine';
	setCoordinators();

	const { queryEngine } = setQueryContext(initDuckDB());

	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec([
				msql.loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString(),
				msql.loadCSV('driving', `${window.location.origin}/data/driving.csv`).toString()
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
		<h1>Bar Labels</h1>
		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer>
					{#snippet background()}
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<MarginLabel />
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<BarMarkX table="penguins" x={msql.count()} y="species" />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
						<TextMark
							table="penguins"
							x={msql.count()}
							y="species"
							text={msql.count()}
							dx={-8}
							textAnchor="end"
							fontSize={12}
							fill="white"
						/>
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>

	<div class="container">
		<h1>Scatter Annotations</h1>
		<div class="charts">
			<div class="chart-wrapper-tall">
				<ChartContainer>
					{#snippet background()}
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<MarginLabel />
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<DotsMark table="penguins" x="bill_length" y="body_mass" fill="species" />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
						<TextMark
							table="penguins"
							x="bill_length"
							y="body_mass"
							text="species"
							dy={-10}
							fontSize={9}
							fill="species"
						/>
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>

	<div class="container">
		<h1>Connected Scatterplot</h1>
		<div class="charts">
			<div class="chart-wrapper-tall">
				<ChartContainer>
					{#snippet background()}
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<MarginLabel />
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<LineMark
									table="driving"
									x="miles"
									y="gas"
									order="year"
									strokeWidth={1}
									curve="catmull-rom"
								/>
								<DotsMark
									table="driving"
									x="miles"
									y="gas"
									r={2}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<TextMark
							table="driving"
							x="miles"
							y="gas"
							text="year"
							fontSize={9}
							dy={-8}
						/>
					{/snippet}
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
		aspect-ratio: 2 / 1;
		min-height: 200px;
		max-height: 300px;
		position: relative;
	}

	.chart-wrapper-tall {
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
