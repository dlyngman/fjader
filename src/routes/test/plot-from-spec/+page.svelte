<script lang="ts">
	/**
	 * PlotFromSpec in the browser: the path the Python package and the marimo
	 * and Streamlit widgets take, rendered from specs as they send them. Each
	 * case says what should happen.
	 */
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { onMount } from 'svelte';
	import { initFjader } from '$lib';
	import PlotFromSpec from '$lib/spec/PlotFromSpec.svelte';
	import type { PlotSpec } from '$lib/spec/types';

	const { queryEngine } = initFjader();

	let isLoaded = $state(false);
	let loadError = $state<string | null>(null);

	onMount(async () => {
		try {
			await queryEngine.exec([
				loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString(),
				// Feature importances with long names, as a bar_x of them has (cases 4–7)
				`CREATE TABLE features AS SELECT * FROM (VALUES
					('mean_transaction_amount_30d', 0.31), ('days_since_last_login', 0.22),
					('number_of_support_tickets', 0.17), ('account_age_in_months', 0.12),
					('region', 0.08)
				) AS t(feature, importance)`
			]);
			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = (error as Error).message;
		}
	});

	interface Case {
		title: string;
		desc: string;
		spec: PlotSpec;
	}

	const cases: Case[] = [
		{
			title: '1. Brush and legend on top',
			desc: 'A brush on x and an auto-detected legend (legend: true) above the plot. Brush: case 2’s bars filter by it. Click a species in the legend: case 1 dims the other species, and case 2’s island bars get shorter (only that species is counted); their colours stay, since they are coloured by island.',
			spec: {
				height: 320,
				xLabel: 'bill_length',
				yLabel: 'bill_depth',
				marks: [
					{
						mark: 'dot',
						table: 'penguins',
						x: 'bill_length',
						y: 'bill_depth',
						fill: 'species',
						selection: 'spec'
					}
				],
				interactors: [{ interactor: 'intervalX' }],
				legend: true
			}
		},
		{
			title: '2. Toggle and legend at the right',
			desc: 'Click a bar or an axis label to toggle an island; the legend sits at the right, vertical. Case 1 follows the toggle.',
			spec: {
				height: 320,
				xLabel: 'island',
				yLabel: 'count',
				marks: [
					{
						mark: 'barY',
						table: 'penguins',
						x: 'island',
						y: 'count()',
						fill: 'island',
						selection: 'spec'
					}
				],
				interactors: [{ interactor: 'toggle', field: 'island' }],
				legend: { color: 'island', position: 'right' }
			}
		},
		{
			title: '3. A facet grid with a brush',
			desc: 'Faceted by species, with a 2D brush: one rectangle for the chart, drawn in every cell, writing one selection; case 3b counts what it selects. A brush does not filter its own chart.',
			spec: {
				height: 280,
				xLabel: 'bill_length',
				yLabel: 'bill_depth',
				fx: 'species',
				marks: [
					{
						mark: 'dot',
						table: 'penguins',
						x: 'bill_length',
						y: 'bill_depth',
						fill: 'island',
						selection: 'specfacet'
					}
				],
				interactors: [{ interactor: 'interval2D' }],
				legend: { color: 'island' }
			}
		},
		{
			title: '3b. What the facet brush selects',
			desc: 'Counts per island in case 3’s selection.',
			spec: {
				height: 220,
				xLabel: 'island',
				yLabel: 'count',
				marks: [
					{
						mark: 'barY',
						table: 'penguins',
						x: 'island',
						y: 'count()',
						fill: 'island',
						selection: 'specfacet'
					}
				]
			}
		},
		{
			title: '4. y title on top (yTitlePlacement)',
			desc: 'Long category labels: the y title "feature" sits horizontally above the plot at the axis, not rotated into the labels.',
			spec: {
				height: 240,
				xLabel: 'importance',
				yLabel: 'feature',
				yTitlePlacement: 'top',
				marks: [{ mark: 'barX', table: 'features', x: 'importance', y: 'feature' }]
			}
		},
		{
			title: '5. y title clear of the labels (yTitleOffset: auto)',
			desc: 'The rotated y title sits left of the widest label, as far as the left margin allows, instead of 32 px from the axis.',
			spec: {
				height: 240,
				xLabel: 'importance',
				yLabel: 'feature',
				yTitleOffset: 'auto',
				margin: { left: 230 },
				marks: [{ mark: 'barX', table: 'features', x: 'importance', y: 'feature' }]
			}
		},
		{
			title: '6. x title at the end, no frame (xTitleAnchor, frame: false)',
			desc: 'The x title "importance" sits at the right end of the axis, and there is no border around the plot area.',
			spec: {
				height: 240,
				xLabel: 'importance',
				yLabel: 'feature',
				xTitleAnchor: 'end',
				frame: false,
				marks: [{ mark: 'barX', table: 'features', x: 'importance', y: 'feature' }]
			}
		},
		{
			title: '7. No titles (xLabel and yLabel empty)',
			desc: 'Neither axis has a title: an empty label draws none, rather than falling back to the column name.',
			spec: {
				height: 240,
				xLabel: '',
				yLabel: '',
				marks: [{ mark: 'barX', table: 'features', x: 'importance', y: 'feature' }]
			}
		},
		{
			title: '8. Facet grid: y title on top, no frame, legend at the right',
			desc: 'One cell per island, no frames. Each cell has the island name at the top and its y title "species" below it, just above the plot, without overlapping, however narrow the cells. The legend at the right starts level with the first row of plots (#143).',
			spec: {
				height: 260,
				fx: 'island',
				xLabel: 'count',
				yLabel: 'species',
				yTitlePlacement: 'top',
				frame: false,
				legend: { color: 'species', position: 'right' },
				marks: [{ mark: 'barX', table: 'penguins', x: 'count()', y: 'species', fill: 'species' }]
			}
		}
	];
</script>

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading penguins…</p>
{:else}
	<div class="cases">
		{#each cases as c (c.title)}
			<section>
				<h3>{c.title}</h3>
				<p class="desc">{c.desc}</p>
				<PlotFromSpec spec={c.spec} />
			</section>
		{/each}
	</div>
{/if}

<style>
	.cases {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(480px, 1fr));
		gap: 24px;
		padding: 16px;
	}

	h3 {
		margin: 0 0 4px;
		font-size: 14px;
	}

	.desc {
		margin: 0 0 8px;
		font-size: 12px;
		color: #666;
	}

	.status {
		padding: 16px;
	}

	.error {
		color: #b00;
	}
</style>
