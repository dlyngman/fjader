<script>
	import { avg, min, max } from '@uwdata/mosaic-sql';
	import {
		ChartContainer,
		Grid,
		Crosshair,
		WebGPUCanvas,
		LineMark,
		AreaMarkY,
		IntervalX,
		DerivedIntervalX
	} from '$lib/components';
</script>

<div class="main-view-container">
	<div class="charts-stack">
		<!-- Detail chart: domain follows overview brush -->
		<div class="detail-wrapper">
			<ChartContainer xLabel="ts" yLabel="value" useXSelection>
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="timeseries"
								x="ts"
								y="value"
								stroke="grp"
								strokeWidth={1.5}
								fitDomain="y"
								preferredXScaleType="time"
								tooltipProximity="x"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Overview chart: brushable, with derived ghost overlay -->
		<div class="overview-wrapper">
			<ChartContainer
				xLabel="ts"
				yLabel="value"
				margin={{ top: 10, right: 50, bottom: 25, left: 75 }}
				yDisableZoom
			>
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<LineMark
								table="timeseries"
								x="ts"
								y="value"
								stroke="grp"
								strokeWidth={1}
								preferredXScaleType="time"
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet interactors()}
					<IntervalX selection="brush" />
					<DerivedIntervalX
						sourceSelection="brush"
						selection="comparison"
						offset="-1yw"
					/>
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Hourly distribution: primary vs comparison -->
		<div class="hourly-row">
			<div class="hourly-chart">
				<h3>Selected period</h3>
				<ChartContainer xLabel="hour" yLabel="kWh">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<AreaMarkY
									table="timeseries"
									x="hour"
									y1={min('value')}
									y2={max('value')}
									fill="grp"
									fillOpacity={0.15}
									selection="brush"
									curve="monotone"
								/>
								<LineMark
									table="timeseries"
									x="hour"
									y={avg('value')}
									stroke="grp"
									strokeWidth={2}
									selection="brush"
									curve="monotone"
									tooltipProximity="x"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}

					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>

			<div class="hourly-chart">
				<h3>Comparison period</h3>
				<ChartContainer xLabel="hour" yLabel="kWh">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<AreaMarkY
									table="timeseries"
									x="hour"
									y1={min('value')}
									y2={max('value')}
									fill="grp"
									fillOpacity={0.15}
									selection="comparison"
									curve="monotone"
								/>
								<LineMark
									table="timeseries"
									x="hour"
									y={avg('value')}
									stroke="grp"
									strokeWidth={2}
									selection="comparison"
									curve="monotone"
									tooltipProximity="x"
								/>
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
</div>

<style>
	.main-view-container {
		width: 100%;
		max-width: 1200px;
		margin: 0 auto;
	}

	.charts-stack {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.detail-wrapper {
		width: 100%;
		height: 350px;
	}

	.overview-wrapper {
		width: 100%;
		height: 120px;
	}

	.hourly-row {
		display: flex;
		gap: 16px;
		margin-top: 8px;
	}

	.hourly-chart {
		flex: 1;
		height: 300px;
	}

	.hourly-chart h3 {
		margin: 0 0 4px 0;
		font-size: 13px;
		color: #666;
		font-weight: 500;
	}
</style>
