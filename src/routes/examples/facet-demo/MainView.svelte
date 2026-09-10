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

	<!-- 3. Reordered cells: the case where a facet id and a cell index differ -->
	<h2>Faceted Bars — cells reordered by fxDomain</h2>
	<p class="note">
		Cell order is Gentoo, Adelie, Chinstrap, while the dim numbers them alphabetically — so a cell's
		index and the id it renders are different numbers in every cell but one. Every other facet chart
		has them equal, which makes this the only place a confusion between the two is visible. Each
		cell's bars must belong to the species in its own heading.
		<br />
		It facets on its own column, <code>species_ordered</code>, because a facet scale is shared by
		every container faceting on the same field — so an <code>fxDomain</code> here would otherwise reorder
		the two charts above with it.
	</p>
	<div class="chart-wrapper">
		<ChartContainer
			xLabel="species"
			yLabel="count"
			fx="species_ordered"
			fxDomain={['Gentoo', 'Adelie', 'Chinstrap']}
		>
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<BarMarkY
							table="penguins_fx_ordered"
							x="species_ordered"
							y={count()}
							fill="species_ordered"
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
			{#snippet background()}
				<Frame />
				<AxisLeft />
				<AxisBottom />
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

	.note {
		margin: 0 0 8px 0;
		font-size: 12px;
		color: #666;
		max-width: 80ch;
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
