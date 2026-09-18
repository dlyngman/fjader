<script>
	import { loadParquet, count, dateMonthDay } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		DotsMark,
		IntervalX,
		Legend
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import BarMarkX from '$lib/components/marks/BarMarkX.svelte';
	import Toggle from '$lib/interactors/Toggle.svelte';

	const { queryEngine } = initDivePlot();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec(
				loadParquet('weather', `${window.location.origin}/data/seattle-weather.parquet`).toString()
			);

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
		<h1>Seattle Weather</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer legendPosition="top">
					{#snippet legend()}
						<Legend color="weather" selection="brush" />
					{/snippet}
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
								<DotsMark
									table="weather"
									x={dateMonthDay('date')}
									y="temp_max"
									fill="weather"
									r="precipitation"
									preferredXScaleType="time"
									selection="brush"
									domain={{ y: ['sun', 'fog', 'drizzle', 'rain', 'snow'] }}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
					{/snippet}

					{#snippet interactors()}
						<IntervalX selection="brush" field={dateMonthDay('date')} />
					{/snippet}
				</ChartContainer>
			</div>

			<div class="chart-wrapper">
				<ChartContainer>
					<!-- {#snippet legend()}
						<Legend color="weather" selection="brush" />
					{/snippet} -->
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
								<!--
									Sorted by count, so a brush on the dots above re-ranks the
									bars and they race into their new order. The ranking is a
									column in the mark's own query, so it follows the brush. No
									explicit domain: one would win over the sort.
								-->
								<BarMarkX
									table="weather"
									x={count()}
									y="weather"
									fill="weather"
									selection="brush"
									sort={{ y: 'x', order: 'desc' }}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
					{/snippet}

					{#snippet interactors()}
						<Toggle selection="brush" field="weather" />
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>
{/if}

<style>
	.container {
		max-width: 1200px;
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
		max-height: 400px;
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
