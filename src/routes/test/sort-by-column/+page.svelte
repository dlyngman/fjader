<script>
	import { count } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import { ChartContainer, Grid, AxisLeft, AxisBottom, BarMarkX, BarMarkY } from '$lib/components';

	const { queryEngine } = initFjader();

	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec(`
				CREATE TABLE features AS
				SELECT * FROM (VALUES ('a', 1.0), ('b', 4.0), ('c', 2.0), ('d', 3.0)) AS t(feature, importance);
				CREATE TABLE grouped AS
				SELECT * FROM (VALUES
					('a', 'g1'), ('a', 'g2'), ('b', 'g1'), ('c', 'g2'), ('c', 'g1'), ('c', 'g2')
				) AS t(feature, "group");
			`);
			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});

	// The sort prop given a column name, a channel name, a misspelled name, and a
	// column only a categorical channel reads.
	const cases = [
		{
			title: 'By column name: sort={{ y: "importance" }}',
			expect: 'Sorted, largest first: b, d, c, a.',
			sort: { y: 'importance', order: 'desc' }
		},
		{
			title: 'By channel name: sort={{ y: "x" }}',
			expect: 'The same order as the chart above.',
			sort: { y: 'x', order: 'desc' }
		},
		{
			title: 'Misspelled: sort={{ y: "importanse" }}',
			expect: 'Unsorted (a, b, c, d), and one console warning: neither a channel nor a column.',
			sort: { y: 'importanse', order: 'desc' }
		}
	];
</script>

{#if loadError}
	<div class="status">Error: {loadError}</div>
{:else if !isLoaded}
	<div class="status">Loading data...</div>
{:else}
	<div class="page">
		<h1>sort by column</h1>
		<p class="subtitle">
			A mark's <code>sort</code> prop given a column name, a channel name, or neither. Check the console
			for the warnings.
		</p>

		<div class="grid">
			{#each cases as c (c.title)}
				<section>
					<h2>{c.title}</h2>
					<p class="desc">{c.expect}</p>
					<div class="chart-wrapper">
						<ChartContainer xLabel="importance" yLabel="feature">
							<Grid />
							<AxisLeft />
							<AxisBottom />
							<BarMarkX table="features" x="importance" y="feature" sort={c.sort} />
						</ChartContainer>
					</div>
				</section>
			{/each}

			<section>
				<h2>Categorical only: sort={'{{ x: "group" }}'}</h2>
				<p class="desc">
					Bars draw unsorted (a, b, c), stacked by group. One console warning: read only by a
					categorical channel. No DuckDB error.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="feature" yLabel="count">
						<Grid />
						<AxisLeft />
						<AxisBottom />
						<BarMarkY
							table="grouped"
							x="feature"
							y={count()}
							fill="group"
							sort={{ x: 'group', order: 'desc' }}
						/>
					</ChartContainer>
				</div>
			</section>
		</div>
	</div>
{/if}

<style>
	.page {
		max-width: 1200px;
		margin: 0 auto;
		padding: 1.5rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0 0 0.25rem 0;
	}
	h2 {
		font-size: 1rem;
		margin: 0 0 0.25rem 0;
	}
	.subtitle,
	.desc {
		color: #666;
		margin: 0 0 0.75rem 0;
		font-size: 0.9rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
		gap: 1.5rem;
	}
	.chart-wrapper {
		width: 100%;
		height: 240px;
		position: relative;
		border: 1px solid #ddd;
	}
	.status {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 200px;
		padding: 2rem;
	}
</style>
