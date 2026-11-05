<script>
	// Does a selection in one filter group dim charts in another?
	//
	// Two filter groups, "groupA" and "groupB", each with a carrier bar chart
	// (x=carrier, fill=carrier, a Toggle) and a delay histogram. Group A also has
	// a carrier legend. Both carrier charts share the carrier colour scale, since
	// colour scales are keyed by field and the scale registry is per page.
	//
	// What to check:
	// - Click a carrier in group A's bars or legend. Group A's histogram should
	//   filter, and group B's histogram should not change (separate group).
	// - The leak: do group B's carrier bars dim too? If they do, the selection
	//   reaches group B through the shared colour scale's activity table.
	// - Click a carrier in group B: same question the other way round.

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
		RectYMark,
		Legend
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import { bin } from '$lib/sql/bin';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			const url = `${window.location.origin}/data/flights-200k.parquet`;
			await queryEngine.exec(`
				CREATE TABLE cg_flights AS
				SELECT delay, ['AA', 'DL', 'UA', 'WN', 'B6'][1 + (row_number() OVER () % 5)::INT] AS carrier
				FROM read_parquet('${url}')
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
	<p class="status">Loading…</p>
{:else}
	<div class="container">
		<h1>Selections across filter groups</h1>
		<p class="lede">
			Click a carrier in group A (bars or legend). Group A's histogram should filter and group B's
			should not. The question: do group B's carrier bars dim too?
		</p>

		{#each ['groupA', 'groupB'] as group (group)}
			<h2>{group}</h2>
			<div class="grid">
				<div class="panel">
					<ChartContainer xLabel="carrier" yLabel="count" legendPosition="top">
						{#snippet legend()}
							{#if group === 'groupA'}
								<Legend color="carrier" selection={group} />
							{/if}
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
										table="cg_flights"
										x="carrier"
										y={count()}
										fill="carrier"
										selection={group}
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
						{#snippet interactors()}
							<Toggle selection={group} field="carrier" />
						{/snippet}
					</ChartContainer>
				</div>
				<div class="panel">
					<ChartContainer xLabel="delay" yLabel="count">
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
									<RectYMark
										table="cg_flights"
										x={bin('delay', { steps: 50 })}
										y={count()}
										inset={0.5}
										fill="steelblue"
										selection={group}
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	.container {
		max-width: 1300px;
		margin: 0 auto;
		padding: 24px 16px;
	}
	.lede {
		color: #555;
		max-width: 80ch;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
		gap: 16px;
	}
	.panel {
		height: 320px;
	}
	.status.error {
		color: #b00020;
	}
</style>
