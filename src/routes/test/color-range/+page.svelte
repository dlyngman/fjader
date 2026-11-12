<script>
	/**
	 * Explicit ordinal colours: `fill={{ field, domain, range }}`.
	 *
	 * 1. A 0/1 INTEGER column pinned with domain [1, 0]: 1 green, 0 red. Without
	 *    the pin, colours follow sorted value order and 0 would take the first,
	 *    green; so red 0 / green 1 here shows the pin at work.
	 * 2. The same pin on a column that also holds 2, outside the pinned domain:
	 *    those segments draw the null colour (grey).
	 * 3. A range alone on a string column: a custom palette in sorted value
	 *    order, so away blue, home orange, neutral grey.
	 */
	import { count } from '@uwdata/mosaic-sql';
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
		Legend
	} from '$lib/components';
	import { stack } from '$lib/transforms';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	const RED = '#d62728';
	const GREEN = '#2ca02c';
	// Listed 1 first: the reverse of sorted order, which only the pin can produce
	const winLoss = { domain: [1, 0], range: [GREEN, RED] };

	const charts = [
		{ title: '1 → green, 0 → red, by the pin', field: 'won', color: { field: 'won', ...winLoss } },
		{
			title: 'Same pin; outcome also holds 2 (null colour)',
			field: 'outcome',
			color: { field: 'outcome', ...winLoss }
		},
		{
			title: 'Range alone: away blue, home orange, neutral grey',
			field: 'venue',
			color: { field: 'venue', range: ['#4e79a7', '#f28e2b', '#bab0ac'] }
		}
	];

	onMount(async () => {
		try {
			await queryEngine.exec(`
				CREATE TABLE games AS
				SELECT
					['Ajax', 'Brugge', 'Celtic', 'Dynamo'][1 + (i % 4)] AS team,
					(hash(i) % 3 > 0)::INTEGER AS won,
					CASE WHEN i % 7 = 0 THEN 2 ELSE (hash(i) % 3 > 0)::INTEGER END AS outcome,
					['home', 'away', 'neutral'][1 + (hash(i * 31) % 3)::INTEGER] AS venue
				FROM range(400) t(i);
			`);
			isLoaded = true;
		} catch (error) {
			console.error(error);
			loadError = error.message;
		}
	});
</script>

<div class="container">
	{#if loadError}
		<p>Error: {loadError}</p>
	{:else if !isLoaded}
		<p>Loading…</p>
	{:else}
		{#each charts as chart (chart.field)}
			<div class="chart-section">
				<h2>{chart.title}</h2>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Team" yLabel="Games" legendPosition="top">
						{#snippet legend()}
							<Legend color={chart.field} />
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
									<BarMarkY
										table="games"
										x="team"
										y={count()}
										fill={chart.color}
										transforms={[stack()]}
										tooltip
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>
		{/each}
	{/if}
</div>

<style>
	.container {
		padding: 2rem;
		font-family: system-ui, sans-serif;
	}
	.chart-section {
		margin-bottom: 2rem;
	}
	.chart-wrapper {
		width: 640px;
		height: 320px;
	}
</style>
