<script>
	import { count } from '@uwdata/mosaic-sql';
	import {
		ChartContainer,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		DotsMark,
		BarMarkY,
		LineMark,
		AreaMarkY,
		Frame,
		Crosshair
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
</script>

<div class="demo-scroll">
	<!-- 1. Dots (existing) -->
	<h2>Faceted Dots — fx="species"</h2>
	<div class="chart-wrapper">
		<ChartContainer xLabel="bill_length" yLabel="bill_depth" fx="species">
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<DotsMark
							table="penguins"
							x="bill_length"
							y="bill_depth"
							fill="species"
							r={4}
							opacity={0.7}
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
			{#snippet background()}
				<Frame />
				<AxisLeft />
				<AxisBottom />
				<MarginLabel anchor="bottom" label="Bill Length (mm)" />
				<MarginLabel anchor="left" label="Bill Depth (mm)" />
			{/snippet}
			{#snippet foreground()}
				<Crosshair />
			{/snippet}
		</ChartContainer>
	</div>

	<!-- 2. Bars -->
	<h2>Faceted Bars — fx="species"</h2>
	<div class="chart-wrapper">
		<ChartContainer xLabel="island" yLabel="count" fx="species">
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid axis="y" />
						<BarMarkY table="penguins" x="island" y={count()} fill="island" opacity={0.8} />
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
			{#snippet background()}
				<Frame />
				<AxisLeft />
				<AxisBottom />
				<MarginLabel anchor="bottom" label="Island" />
				<MarginLabel anchor="left" label="Count" />
			{/snippet}
			{#snippet foreground()}
				<Crosshair />
			{/snippet}
		</ChartContainer>
	</div>

	<!-- 3. Lines -->
	<h2>Faceted Lines — fx="series"</h2>
	<div class="chart-wrapper">
		<ChartContainer xLabel="x" yLabel="y" fx="series">
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<LineMark table="facet_timeseries" x="x" y="y" stroke="series" strokeWidth={2} />
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
			{#snippet background()}
				<Frame />
				<AxisLeft />
				<AxisBottom />
				<MarginLabel anchor="bottom" label="X" />
				<MarginLabel anchor="left" label="Y" />
			{/snippet}
			{#snippet foreground()}
				<Crosshair />
			{/snippet}
		</ChartContainer>
	</div>

	<!-- 4. Area -->
	<h2>Faceted Area — fx="series"</h2>
	<div class="chart-wrapper">
		<ChartContainer xLabel="x" yLabel="y" fx="series">
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<AreaMarkY
							table="facet_timeseries"
							x="x"
							y="y"
							fill="series"
							fillOpacity={0.4}
							strokeWidth={1.5}
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
			{#snippet background()}
				<Frame />
				<AxisLeft />
				<AxisBottom />
				<MarginLabel anchor="bottom" label="X" />
				<MarginLabel anchor="left" label="Y" />
			{/snippet}
			{#snippet foreground()}
				<Crosshair />
			{/snippet}
		</ChartContainer>
	</div>
</div>

<style>
	h2 {
		margin: 24px 0 8px 0;
		font-size: 15px;
		font-weight: 500;
		color: #333;
	}

	h2:first-child {
		margin-top: 0;
	}

	.demo-scroll {
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}

	.chart-wrapper {
		height: 280px;
		display: flex;
		flex-direction: column;
	}
</style>
