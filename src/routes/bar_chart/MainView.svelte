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
			<DotsMark
			  table="penguins"
			  x={max("bill_length")}
			  y="species"
			  orientation="horizontal"
			  alpha="0.8"
			  preferredYScaleType = 'band'
			/>
		  {/snippet}
		</WebGPUCanvas>
	  {/snippet}
  
	  {#snippet foreground()}
		<Crosshair />
	  {/snippet}
	</ChartContainer>
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
