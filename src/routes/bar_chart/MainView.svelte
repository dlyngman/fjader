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
		BarMark,
		BarMarkX
	} from '$lib/components';
	import Rects from '$lib/components/rendering/Rects.svelte';

	const coordinator = getContext('mosaic-coordinator');
	const selection = Selection.crossfilter();

	// Create test data
	const x0Data = new Float32Array([10, 60, 20]);     // Left edges
	const x1Data = new Float32Array([50, 100, 80]);    // Right edges
	const y0Data = new Float32Array([10, 10, 30]);      // Bottom edges  
	const y1Data = new Float32Array([50, 30, 80]);      // Top edges
	const colorData = new Float32Array([
	1,0,0,1,  // Red rectangle
	0,1,0,1,  // Green rectangle
	0,0,1,1   // Blue rectangle
	]);
	const alphaData = new Float32Array([0.3, 0.2, 0.3]);

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
			<BarMarkX
			  table="penguins"
			  x1={min("bill_length")}
			  x2={max("bill_length")}
			  y="species"
			  color="red"
			  alpha={1}
			  preferredYScaleType = 'band'
			/>
			<!-- <Rects 
				{x0Data} {x1Data} {y0Data} {y1Data} 
				{colorData} {alphaData} 
				dataVersion={1} 
			/> -->
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
