<script lang="ts">
	import { count } from '@uwdata/mosaic-sql';
	import {
		ChartContainer,
		DotsMark,
		LineMark,
		BarMarkY,
		BarMarkX,
		AreaMarkY,
		AreaMarkX,
		RectYMark,
		WebGPUCanvas,
		Grid,
		Crosshair
	} from '$lib/components';
	import { bin } from '$lib/sql/bin';
</script>

<div class="test-page">
	<h2>Command Palette — All Mark Types</h2>
	<p class="instructions">
		Right-click any chart to open the palette. Verify: channel list, column assignment,
		preview-on-hover, clear, reset all, Escape to cancel, Cmd+Z to undo.
	</p>

	<div class="charts-grid">
		<div class="chart-cell">
			<h3>DotsMark</h3>
			<div class="chart">
				<ChartContainer xLabel="bill_length" yLabel="bill_depth">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<DotsMark table="penguins" x="bill_length" y="bill_depth" fill="species" r={3} />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
		</div>

		<div class="chart-cell">
			<h3>LineMark</h3>
			<div class="chart">
				<ChartContainer xLabel="x" yLabel="y">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<LineMark table="timeseries" x="x" y="y" stroke="series" strokeWidth={2} />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
		</div>

		<div class="chart-cell">
			<h3>BarMarkY</h3>
			<div class="chart">
				<ChartContainer xLabel="species" yLabel="body_mass">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<BarMarkY table="penguins" x="species" y="body_mass" fill="species" />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
		</div>

		<div class="chart-cell">
			<h3>BarMarkX</h3>
			<div class="chart">
				<ChartContainer xLabel="body_mass" yLabel="species">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<BarMarkX table="penguins" x="body_mass" y="species" fill="species" />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
		</div>

		<div class="chart-cell">
			<h3>AreaMarkY</h3>
			<div class="chart">
				<ChartContainer xLabel="x" yLabel="y">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<AreaMarkY table="timeseries" x="x" y="y" fill="series" curve="monotone" />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
		</div>

		<div class="chart-cell">
			<h3>AreaMarkX</h3>
			<div class="chart">
				<ChartContainer xLabel="y" yLabel="x">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<AreaMarkX table="timeseries" x="y" y="x" fill="series" curve="monotone" />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
		</div>

		<div class="chart-cell">
			<h3>RectYMark (histogram)</h3>
			<div class="chart">
				<ChartContainer xLabel="bill_length" yLabel="count">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<RectYMark table="penguins" x={bin('bill_length', { steps: 30 })} y={count()} fill="steelblue" />
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
	.test-page {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	h2 {
		margin: 0;
		font-size: 1.2rem;
	}
	h3 {
		margin: 0 0 0.25rem;
		font-size: 0.9rem;
		color: #555;
	}
	.instructions {
		margin: 0;
		font-size: 0.9rem;
		color: #666;
	}
	.charts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
		gap: 1rem;
	}
	.chart-cell {
		display: flex;
		flex-direction: column;
	}
	.chart {
		height: 280px;
	}
</style>
