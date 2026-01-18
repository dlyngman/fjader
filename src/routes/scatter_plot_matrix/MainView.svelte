<script>
	import { Selection } from '@uwdata/mosaic-core';
	import { sum, min, max } from '@uwdata/mosaic-sql';
	import { setContext, getContext, onMount } from 'svelte';
	import {
		ChartContainer,
		ColumnSelector,
		Grid,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		DotsMark,
		BarMark
	} from '$lib/components';
  import BarMarkX from '$lib/components/marks/BarMarkX.svelte';

	import DomainTestButtons from '$lib/components/debug/DomainTestButtons.svelte';

	const coordinator = getContext('mosaic-coordinator');
	const selection = Selection.crossfilter();

	let chartConfig = $state([
		{
			id: '1',
			table: 'penguins',
			x: 'bill_length',
			y: 'bill_depth'
		},
		{
			id: '2',
			table: 'penguins',
			// x: 'body_mass',
			x: 'bill_length',
			y: 'bill_depth'
			// y: 'bill_depth'
		},
		{
			id: '3',
			table: 'penguins',
			x: 'bill_length',
			y: 'flipper_length'
		},
		{
			id: '4',
			table: 'penguins',
			x: 'bill_depth', //'body_mass',
			y: 'flipper_length'
		}
	]);

	let gridRows = $state(1);
	let gridColumns = $state(1);

	setContext('chartConfig', {
		get chartConfig() {
			return chartConfig;
		},
		set chartConfig(value) {
			chartConfig = value;
		},
		get gridRows() {
			return gridRows;
		},
		set gridRows(value) {
			gridRows = value;
		},
		get gridColumns() {
			return gridColumns;
		},
		set gridColumns(value) {
			gridColumns = value;
		}
	});

	let webGPU = $state(true);
</script>

<div class="main-view-container">
	<ColumnSelector />

	<div class="charts-container" style="--grid-rows: {gridRows}; --grid-columns: {gridColumns};">
		{#each chartConfig as config, i (config.id)}
			<div class="chart-wrapper">
				<ChartContainer xLabel={config.x} yLabel={config.y}>
					{#snippet background()}
						<!-- <Grid />
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<MarginLabel /> -->
					{/snippet}

					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								{#if webGPU}
									<DotsMark
										table={'penguins'}
										x={config.x}
										y={config.y}
										color={'species'}
										alpha="1.0"
										radius="5"
									/>
								{/if}
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<!-- <Crosshair /> -->
					{/snippet}

					{#snippet overlay()}
						{#if i === 0}
							<DomainTestButtons offsetPercent={20} />
						{/if}
					{/snippet}
				</ChartContainer>
			</div>
		{/each}
	</div>

	<div class="charts-container">
    <div class="chart-wrapper">
      <ChartContainer xLabel="body_mass" yLabel="species">
        {#snippet canvas()}
          <WebGPUCanvas>
            {#snippet canvasComponents()}
              <BarMarkX 
                table="penguins" 
                x="body_mass" 
                y="species" 
                color="species" />
            {/snippet}
          </WebGPUCanvas>
        {/snippet}
      </ChartContainer>
    </div>
	</div>
</div>

<style>
	.main-view-container {
		width: 100%;
		display: flex;
		flex-direction: column;
		/* align-items: center; */
		padding-bottom: 40px; /* Ensure space at bottom */
	}

	.charts-container {
		display: grid;
		grid-template-rows: repeat(var(--grid-rows), auto);
		grid-template-columns: repeat(var(--grid-columns), 1fr);
		gap: 10px;
		width: 80%;
		max-width: 1600px;
		margin: 20px auto;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 200px;
		max-height: 400px;
		position: relative; /* Important for containing absolutely positioned children */
	}
</style>
