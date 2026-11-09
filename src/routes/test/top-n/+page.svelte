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
		BarMarkX,
		Legend
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import { topN } from '$lib/transforms';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			// Table 1: 10 categories, pre-aggregated (1 row each)
			await queryEngine.exec(`
				CREATE TABLE top_n_sales AS
				SELECT * FROM (VALUES
					('Electronics', 500),
					('Clothing', 300),
					('Food', 250),
					('Books', 200),
					('Toys', 150),
					('Sports', 120),
					('Garden', 80),
					('Health', 60),
					('Auto', 40),
					('Music', 20)
				) AS t(category, revenue)
			`);

			// Table 2: 10 categories x 3 regions = 30 rows
			// Deliberately skewed so filtering by region changes the top 5:
			//   All regions: Electronics(500), Clothing(300), Food(250), Music(210), Books(200)
			//   North only:  Music(200), Garden(180), Health(150), Auto(140), Sports(130)
			//   South only:  Electronics(400), Clothing(250), Food(200), Books(170), Toys(130)
			//   West only:   Electronics(90), Food(45), Clothing(40), Books(25), Toys(15)
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
</script>

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading...</p>
{:else}
	<div class="container">
		<h1>topN Transform Test</h1>
		<p class="subtitle">topN runs in SQL, includeOthers included (charts 2–4, 6, 7)</p>

		<div class="charts-grid">
			<!-- Chart 1: Baseline -->
			<div class="chart-panel">
				<h3>1. Baseline (all 10 categories)</h3>
				<p class="desc">All 10 bars visible, sorted by revenue descending. No transforms.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Sales Category" yLabel="Revenue">
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
										table="top_n_sales"
										x="category"
										y={sum('revenue')}
										sort={{ x: 'y', order: 'desc' }}
										tooltip
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<!-- Chart 2: topN(5) -->
			<div class="chart-panel">
				<h3>2. topN(5) — SQL</h3>
				<p class="desc">
					Expect exactly 5 bars: Electronics, Clothing, Food, Books, Toys. Band domain is derived
					from the SQL result, so the axis must show only these 5.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Top 5 Category" yLabel="Revenue">
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
										table="top_n_sales"
										x="category"
										y={sum('revenue')}
										sort={{ x: 'y', order: 'desc' }}
										transforms={[topN(5)]}
										tooltip
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<!-- Chart 3: topN(5, includeOthers) -->
			<div class="chart-panel">
				<h3>3. topN(5, includeOthers: true) — SQL</h3>
				<p class="desc">
					Should show 5 + "Other" bar (revenue 320), with "Other" last in the band domain. Other is
					a SQL bucket over a reserved dim id, so this mark gets dense rows like any other.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Top 5+ Category" yLabel="Revenue">
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
										table="top_n_sales"
										x="category"
										y={sum('revenue')}
										sort={{ x: 'y', order: 'desc' }}
										transforms={[topN(5, { includeOthers: true })]}
										tooltip
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<!-- Chart 4: BarMarkX horizontal -->
			<div class="chart-panel">
				<h3>4. BarMarkX + topN(3) — SQL</h3>
				<p class="desc">
					Horizontal bars; value axis resolved from mark type (x2). Expect exactly 3 bars:
					Electronics, Clothing, Food.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Revenue" yLabel="Sales Category">
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
									<BarMarkX
										table="top_n_sales"
										x={sum('revenue')}
										y="category"
										sort={{ y: 'x', order: 'desc' }}
										transforms={[topN(3)]}
										tooltip
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<!-- Chart 5: Stacked bars with selection (no topN) -->
			<div class="chart-panel">
				<h3>5. Stacked bars with region + category toggles</h3>
				<p class="desc">
					Click a rect or legend swatch to toggle its region; click a band label to toggle that
					category. Both AND together. This chart is the source, so it is excluded from its own
					toggles (axis labels and legend dim; bar dimming is a separate proposal); chart 6 filters.
					Shift-click for multi-select, click empty space to clear.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue" legendPosition="top">
						{#snippet legend()}
							<Legend color="region" selection="brush" />
						{/snippet}
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
										fill="region"
										sort={{ x: 'y', order: 'desc' }}
										selection="brush"
										tooltip
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
						{#snippet interactors()}
							<Toggle selection="brush" field="region" />
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<!-- Chart 6: Selection + topN(5) -->
			<div class="chart-panel">
				<h3>6. Selection + topN(5) — SQL, selectionResponse="filter"</h3>
				<p class="desc">
					selectionResponse="filter": a region selection filters this chart even though it is
					coloured by region, so the top 5 is re-ranked within the subset. Select regions here or in
					chart 5 or 7: a categorical selection filters a "filter" mark in its own chart too. No
					filter: Electronics, Clothing, Food, Music, Books. North only: Music, Garden, Health,
					Auto, Sports. West only: Electronics, Food, Clothing, Books, Toys. Clicking a bar here
					toggles its region, so the other regions' bars leave the chart.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue" legendPosition="top">
						{#snippet legend()}
							<Legend color="region" selection="brush" />
						{/snippet}
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
										fill="region"
										sort={{ x: 'y', order: 'desc' }}
										selection="brush"
										selectionResponse="filter"
										transforms={[topN(5)]}
										tooltip
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
						{#snippet interactors()}
							<Toggle selection="brush" field="region" />
						{/snippet}
					</ChartContainer>
				</div>
			</div>
			<!-- Chart 7: Selection + topN(5, includeOthers) -->
			<div class="chart-panel">
				<h3>7. Selection + topN(5, includeOthers) — SQL, crossfiltered</h3>
				<p class="desc">
					Chart 6 with an Other bucket. Toggling a region re-ranks, and nothing leaves the chart: a
					category dropping out of the top 5 shrinks while travelling INTO Other, and Other's
					stacked segments grow by what it absorbed. Other stays last on the axis. One Other row per
					region, so its stack has the same colours as the bars beside it.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue" legendPosition="top">
						{#snippet legend()}
							<Legend color="region" selection="brush" />
						{/snippet}
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
										fill="region"
										sort={{ x: 'y', order: 'desc' }}
										selection="brush"
										transforms={[topN(5, { includeOthers: true })]}
										tooltip
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
						{#snippet interactors()}
							<Toggle selection="brush" field="region" />
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
