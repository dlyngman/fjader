<script>
	import { getContext } from 'svelte';
	import { Selection } from '@uwdata/mosaic-core';
	import {
		ChartContainer,
		Grid,
		Crosshair,
		WebGPUCanvas,
		LineMark,
		FilterBridge
	} from '$lib/components';
	import { AreaMarkY } from '$lib/components/marks';
	import { IntervalX } from '$lib/interactors';
	import { sum, avg, min, max, sql, frameRows, preceding, currentRow } from '@uwdata/mosaic-sql';
	import { bin } from '$lib/sql/bin';

	const coordinator = getContext('mosaic-coordinator');

	const filterBridge = new FilterBridge(Selection, null);

	// Rolling 7-day (168-hour) sum of value, partitioned by group
	const weeklySumY1 = sum('value')
		.partitionby('grp')
		.orderby('ts')
		.frame(frameRows([preceding(167), currentRow()]));
	const weeklySumY2 = sum('value')
		.partitionby('grp')
		.orderby('ts')
		.frame(frameRows([preceding(167), currentRow()]));

	// Hourly distribution: x = hour of day, y = avg/min/max value
	const hourOfDay = sql`EXTRACT(HOUR FROM "ts")`;
	const avgValue = avg('value');
	const minValue = min('value');
	const maxValue = max('value');
</script>

<div class="main-view-container">
	<h2>Debug Playground</h2>
	<p>Hourly time series — 1 year, 3 groups (~26K points)</p>

	<div class="charts-grid">
		<div class="chart-wrapper thin">
			<h3>Chart</h3>
			<ChartContainer xLabel="ts" yLabel="value weekly">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="hourly_series"
								x={bin('ts', { interval: 'hour' })}
								y={weeklySumY1}
								stroke="grp"
								strokeWidth={1.5}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}

				{#snippet interactors()}
					<IntervalX bridge={filterBridge} />
				{/snippet}
			</ChartContainer>
		</div>
		<div class="chart-wrapper thin">
			<h3>Chart</h3>
			<ChartContainer xLabel="ts" yLabel="value weekly">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="hourly_series"
								x={bin('ts', { interval: 'hour' })}
								y={weeklySumY2}
								stroke="grp"
								strokeWidth={1.5}
								selection={filterBridge.filterSel}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>
		<div class="chart-wrapper">
			<h3>Chart</h3>
			<ChartContainer xLabel="ts" yLabel="value">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<LineMark
								table="hourly_series"
								x={bin('ts', { interval: 'hour' })}
								y="value"
								stroke="grp"
								strokeWidth={1.5}
								selection={filterBridge.filterSel}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}

				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>
		<div class="chart-wrapper">
			<h3>Hourly Distribution</h3>
			<ChartContainer xLabel="hour" yLabel="value" fx="grp">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<AreaMarkY
								table="hourly_series"
								x={hourOfDay}
								y1={minValue}
								y2={maxValue}
								fill="grp"
								fillOpacity={0.3}
								selection={filterBridge.filterSel}
								curve="monotone"
							/>
							<LineMark
								table="hourly_series"
								x={hourOfDay}
								y={avgValue}
								stroke="grp"
								strokeWidth={2}
								selection={filterBridge.filterSel}
								curve="monotone"
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

<style>
	.main-view-container {
		width: 100%;
		padding: 20px;
	}

	h2 {
		margin-bottom: 10px;
	}

	p {
		margin-bottom: 20px;
		color: #666;
	}

	.charts-grid {
		display: flex;
		flex-direction: column;
		gap: 20px;
		max-width: 1200px;
	}

	.chart-wrapper {
		width: 100%;
		height: 400px;
	}

	.chart-wrapper.thin {
		height: 200px;
	}

	h3 {
		margin-bottom: 10px;
		font-size: 14px;
		color: #333;
	}
</style>
