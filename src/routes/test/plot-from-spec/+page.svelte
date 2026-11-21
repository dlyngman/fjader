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
				loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString()
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
			desc: 'A brush on x and an auto-detected legend (legend: true) above the plot. Brush: case 2 filters by it; click a species in the legend: both charts follow.',
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
			desc: 'Faceted by species, with a 2D brush: one rectangle for the chart, drawn in every cell, one selection (the bars below count it). Before, each cell had its own.',
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
