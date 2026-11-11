<script>
	import { sum } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		BarMarkY,
		BarMarkX
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec(`
				CREATE TABLE axis_title_sales AS
				SELECT * FROM (VALUES
					('Consumer electronics', 41250),
					('Household appliances', 32800),
					('Clothing and apparel', 28400),
					('Food and beverages', 19600),
					('Books', 8200)
				) AS t(category, revenue)
			`);
			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading...</p>
{:else}
	<div class="container">
		<h1>Axis titles</h1>
		<p class="subtitle">
			title={false} draws no title; titleOffset="auto" places it clear of the widest tick label.
		</p>

		<div class="charts-grid">
			<div class="chart-panel">
				<h3>1. Default (32px)</h3>
				<p class="desc">Wide ticks (41,250 and the like) run into the title.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue">
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
									<BarMarkY table="axis_title_sales" x="category" y={sum('revenue')} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>2. titleOffset="auto"</h3>
				<p class="desc">
					The title sits clear of the widest tick label. The left margin is the default 75px.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue">
						{#snippet background()}
							<Frame />
							<AxisLeft titleOffset="auto" />
							<AxisBottom />
							<MarginLabel />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<BarMarkY table="axis_title_sales" x="category" y={sum('revenue')} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>3. Band names, auto, wide margin</h3>
				<p class="desc">
					Band names on y. The margin is 170px; auto places the title clear of the longest name.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Revenue" yLabel="Category" margin={{ left: 170 }}>
						{#snippet background()}
							<Frame />
							<AxisLeft titleOffset="auto" />
							<AxisBottom />
							<MarginLabel />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<BarMarkX table="axis_title_sales" x={sum('revenue')} y="category" />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>4. Band names, auto, default margin</h3>
				<p class="desc">
					Names wider than the margin: the title stops at the margin edge (clamped) and the names
					overlap it; only a wider margin fixes that.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Revenue" yLabel="Category">
						{#snippet background()}
							<Frame />
							<AxisLeft titleOffset="auto" />
							<AxisBottom />
							<MarginLabel />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<BarMarkX table="axis_title_sales" x={sum('revenue')} y="category" />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>5. title={false}</h3>
				<p class="desc">No title on either axis. The labels still name the scales.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue">
						{#snippet background()}
							<Frame />
							<AxisLeft title={false} />
							<AxisBottom title={false} />
							<MarginLabel />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<BarMarkY table="axis_title_sales" x="category" y={sum('revenue')} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>6. Fixed offset</h3>
				<p class="desc">A number is taken as given: titleOffset is 60.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue">
						{#snippet background()}
							<Frame />
							<AxisLeft titleOffset={60} />
							<AxisBottom />
							<MarginLabel />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<BarMarkY table="axis_title_sales" x="category" y={sum('revenue')} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>7. titlePlacement="top"</h3>
				<p class="desc">
					Horizontal, above the plot at the axis, so it can't meet the tick labels. Default margin.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue">
						{#snippet background()}
							<Frame />
							<AxisLeft titlePlacement="top" />
							<AxisBottom />
							<MarginLabel />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<BarMarkY table="axis_title_sales" x="category" y={sum('revenue')} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>8. AxisBottom titleAnchor="start"</h3>
				<p class="desc">The x title at the plot's start edge.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue">
						{#snippet background()}
							<Frame />
							<AxisLeft />
							<AxisBottom titleAnchor="start" />
							<MarginLabel />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<BarMarkY table="axis_title_sales" x="category" y={sum('revenue')} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>9. AxisBottom titleAnchor="end"</h3>
				<p class="desc">The x title at the plot's end edge.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue">
						{#snippet background()}
							<Frame />
							<AxisLeft />
							<AxisBottom titleAnchor="end" />
							<MarginLabel />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<BarMarkY table="axis_title_sales" x="category" y={sum('revenue')} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
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
		margin: 0 0 0.25rem 0;
	}

	.subtitle {
		color: #888;
		margin: 0 0 1.5rem 0;
	}

	.charts-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
	}

	.chart-panel {
		border: 1px solid #333;
		border-radius: 8px;
		padding: 1rem;
		background: #111;
	}

	.chart-panel h3 {
		font-size: 0.95rem;
		font-weight: 600;
		margin: 0 0 0.25rem 0;
		color: #eee;
	}

	.desc {
		font-size: 0.8rem;
		color: #999;
		margin: 0 0 0.75rem 0;
		line-height: 1.4;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4 / 3;
		min-height: 250px;
		max-height: 400px;
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
