<script>
	import { Selection } from '@uwdata/mosaic-core';
	import { sum, min, max } from '@uwdata/mosaic-sql';
	import { setContext, getContext } from 'svelte';
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

	let gridRows = $state(2);
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
</script>

<div class="chart-wrapper">
	<ChartContainer xLabel="bill_length" yLabel="species">
	  {#snippet background()}
		<Grid show='x'/>
		<Frame />
		<AxisLeft />
		<AxisBottom />
		<MarginLabel />
	  {/snippet}
  
	  {#snippet canvas()}
		<WebGPUCanvas>
		  {#snippet canvasComponents()}
			<BarMark
			  table="penguins"
			  x={max("bill_length")}
			  y="species"
			  color='sex'
			  orientation="horizontal"
			  alpha="0.8"
			/>
		  {/snippet}
		</WebGPUCanvas>
	  {/snippet}
  
	  {#snippet foreground()}
		<Crosshair />
	  {/snippet}
	</ChartContainer>
  </div>
  
  <!-- For horizontal bars, just change orientation -->
  <!-- <div class="chart-wrapper">
	<ChartContainer xLabel="bill_length" yLabel="species">
	  {#snippet background()}
		<Grid />
		<Frame />
		<AxisLeft />
		<AxisBottom />
		<MarginLabel />
	  {/snippet}
  
	  {#snippet canvas()}
		<WebGPUCanvas>
		  {#snippet canvasComponents()}
			<BarMark
			  table="penguins"
			  x="bill_length"
			  y="species"
			  color="species"
			  orientation="horizontal"
			  alpha="0.8"
			/>
		  {/snippet}
		</WebGPUCanvas>
	  {/snippet}
  
	  {#snippet foreground()}
		<Crosshair />
	  {/snippet}
	</ChartContainer>
  </div> -->


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
