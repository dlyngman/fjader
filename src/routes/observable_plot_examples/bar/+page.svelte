<script>
	import { Coordinator, wasmConnector, Selection } from '@uwdata/mosaic-core';
	import * as msql from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisCenter,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		BarMarkY,
		BarMarkX,
		TextMark,
		FilterBridge,
		Legend
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import { orderby, stack } from '$lib/transforms';

	setCoordinators();

	let coord;
	let isLoaded = $state(false);
	let loadError = $state(null);

	const filterBridge = new FilterBridge(Selection, null);

	onMount(async () => {
		try {
			const wasm = wasmConnector();
			coord = new Coordinator();
			coord.databaseConnector(wasm);
			setContext('mosaic-coordinator', coord);

			await coord.exec([
				msql.loadCSV('alphabet', `${window.location.origin}/data/alphabet.csv`),
				msql.loadCSV('civilizations', `${window.location.origin}/data/civilizations.csv`),
				msql.loadCSV('statepop', `${window.location.origin}/data/us-state-population-2010-2019.csv`, {header: true}),
				msql.loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`)
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
		<h1>Alpahabet</h1>

		<div class="charts">
			<div class="chart-wrapper">
				<ChartContainer>
					{#snippet legend()}
						<Legend color="weather" bridge={filterBridge} />
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
								<BarMarkY table="alphabet" x="letter" y="frequency" />
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
	<div class="container">
		<h1>Penguins</h1>

		<div class="charts">
			<div class="chart-wrapper" style="max-height: 200px;">
				<ChartContainer legendPosition="top">
					{#snippet legend()}
						<Legend color="weather" bridge={filterBridge} />
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
								<BarMarkX
									table="penguins"
									x={1}
									y="species"
									inset={0.5}
									color="body_mass"
									scheme="turbo"
									transforms={[
										orderby(msql.asc('body_mass')),
										stack({ direction: 'horizontal' })
									]}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
					{/snippet}

					{#snippet interactors()}
						<!-- <IntervalX bridge={filterBridge} field={dateMonthDay('date')} /> -->
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>
	<div class="container">
		<h1>Civilizations</h1>

		<div class="charts">
			<div class="chart-wrapper" style="max-height:700px;">
				<ChartContainer legendPosition="top">
					{#snippet legend()}
						<Legend color="weather" bridge={filterBridge} />
					{/snippet}
					{#snippet background()}
						<!-- <Frame /> -->
						<!-- <AxisLeft /> -->
						<AxisBottom />
						<MarginLabel />
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid axis="x"/>
								<BarMarkX
									table="civilizations"
									x1="start"
									x2="end"
									y="civilization"
									inset={0.5}
									sort={{ y: "x1", order: "desc" }}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
						<TextMark
							table="civilizations"
							x="start"
							y="civilization"
							text="civilization"
							textAnchor="end"
							dx={-3}
						/>
					{/snippet}

					{#snippet interactors()}
						<!-- <IntervalX bridge={filterBridge} field={dateMonthDay('date')} /> -->
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>
	<div class="container">
		<h1>Population change, 2010–2019</h1>

		<div class="charts">
			<div class="chart-wrapper" style="max-height:1000px;">
				<ChartContainer legendPosition="top">
					{#snippet background()}
						<AxisBottom tickFormat="+%" />
						<MarginLabel />
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid axis="x"/>
								<BarMarkX
									table="statepop"
									x={msql.sql`(${msql.column('2019')} - ${msql.column('2010')}) * 1.0 / ${msql.column('2010')}`}
									y="State"
									color={msql.sql`SIGN(${msql.column('2019')} - ${msql.column('2010')})`}
									scheme="piyg"
									sort={{ y: "x2", order: "desc" }}
									inset={0.5}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<AxisCenter/>
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>
{/if}

<style>
	.container {
		max-width: 1400px;
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
		max-height: 1000px;
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
