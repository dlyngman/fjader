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
		BarMarkY
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import { topN } from '$lib/transforms';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec(`
				CREATE TABLE top_n_by_region AS
				SELECT * FROM (VALUES
					('Electronics', 'North', 10),  ('Electronics', 'South', 400), ('Electronics', 'West', 90),
					('Clothing', 'North', 10),     ('Clothing', 'South', 250),    ('Clothing', 'West', 40),
					('Food', 'North', 5),          ('Food', 'South', 200),        ('Food', 'West', 45),
					('Books', 'North', 5),         ('Books', 'South', 170),       ('Books', 'West', 25),
					('Toys', 'North', 5),          ('Toys', 'South', 130),        ('Toys', 'West', 15),
					('Sports', 'North', 130),      ('Sports', 'South', 5),        ('Sports', 'West', 5),
					('Garden', 'North', 180),      ('Garden', 'South', 5),        ('Garden', 'West', 5),
					('Health', 'North', 150),      ('Health', 'South', 5),        ('Health', 'West', 5),
					('Auto', 'North', 140),        ('Auto', 'South', 5),          ('Auto', 'West', 5),
					('Music', 'North', 200),       ('Music', 'South', 5),         ('Music', 'West', 5)
				) AS t(category, region, revenue)
			`);
			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});

	const top5 = [topN(5)];
	const top5Other = [topN(5, { includeOthers: true })];
	const byRevenue = { x: 'y', order: 'desc' };
</script>

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading...</p>
{:else}
	<div class="container">
		<h1>A layer in a group nothing writes to</h1>
		<p class="subtitle">
			Click regions in chart 1 (default group). In charts 2 to 4 the faint layer is
			selection="whole", a group no control writes to, and follows the axis
			(contributeDomain=false). Its values never change; its categories are the solid layer's. The
			solid layer is in the default group and is filtered by the region selection (region is not
			drawn there).
		</p>

		<div class="charts-grid">
			<div class="chart-panel">
				<h3>1. Region (the control)</h3>
				<p class="desc">Toggle on region, default group. Click one or more regions.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Region" yLabel="Revenue">
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
									<BarMarkY
										table="top_n_by_region"
										x="region"
										y={sum('revenue')}
										fill="region"
										tooltip
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
						{#snippet interactors()}
							<Toggle field="region" />
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>2. Whole behind part, all 10 categories</h3>
				<p class="desc">
					Faint bars keep every category at its full total; solid bars shrink to the selected
					regions. Check: the y axis does not rescale, tooltips on both layers, and a click on the
					faint bar where the solid one is small.
				</p>
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
									<BarMarkY
										table="top_n_by_region"
										x="category"
										y={sum('revenue')}
										selection="whole"
										contributeDomain={false}
										opacity={0.25}
										tooltip
									/>
									<BarMarkY table="top_n_by_region" x="category" y={sum('revenue')} tooltip />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>3. The same with topN(5), sorted</h3>
				<p class="desc">
					The solid layer ranks (topN, sort) and decides the categories; the faint layer follows
					(contributeDomain=false, no topN). With a region selected the top 5 changes, and the faint
					bars should change with it: the whole of whichever 5 are shown.
				</p>
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
									<BarMarkY
										table="top_n_by_region"
										x="category"
										y={sum('revenue')}
										selection="whole"
										contributeDomain={false}
										opacity={0.25}
										tooltip
									/>
									<BarMarkY
										table="top_n_by_region"
										x="category"
										y={sum('revenue')}
										sort={byRevenue}
										transforms={top5}
										tooltip
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>4. The same with topN(5, includeOthers)</h3>
				<p class="desc">
					As chart 3, with Other on the solid layer. Known gap: the faint layer has no Other row yet
					(it would fold the categories outside the domain into Other), so the solid Other bar has
					no whole behind it.
				</p>
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
									<BarMarkY
										table="top_n_by_region"
										x="category"
										y={sum('revenue')}
										selection="whole"
										contributeDomain={false}
										opacity={0.25}
										tooltip
									/>
									<BarMarkY
										table="top_n_by_region"
										x="category"
										y={sum('revenue')}
										sort={byRevenue}
										transforms={top5Other}
										tooltip
									/>
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
