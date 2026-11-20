<script>
	/**
	 * Flat charts: a chart's components as ChartContainer's children, no
	 * snippets. Each case says what should happen; compare 1 with 2 and 3.
	 *
	 *   ?misuse=1  adds case 6: an overlay placed where it can't draw, for the
	 *              console warning (open DevTools first)
	 */
	import { count, loadParquet } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		ChartContainer,
		AxisLeft,
		AxisBottom,
		WebGPUCanvas,
		BarMarkY,
		Frame,
		Crosshair
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';

	const { queryEngine } = initFjader();
	const misuse = page.url.searchParams.get('misuse') === '1';
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec([
				loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString()
			]);
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
		<h1>Flat charts</h1>
		<p class="subtitle">
			Marks, grid, frame and axes as the chart's children. Cases 1–3 should look the same per cell.
		</p>

		<div class="charts-grid">
			<div class="chart-panel">
				<h3>1. Snippets (reference)</h3>
				<p class="desc">background + canvas snippets, as charts are written today.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="island" yLabel="count">
						{#snippet background()}
							<Frame />
							<AxisLeft />
							<AxisBottom />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid axis="y" />
									<BarMarkY table="penguins" x="island" y={count()} fill="island" />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>2. Flat children</h3>
				<p class="desc">The same chart, no snippets. No SVG under the canvas.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="island" yLabel="count">
						<Frame />
						<Grid axis="y" />
						<AxisLeft />
						<AxisBottom />
						<BarMarkY table="penguins" x="island" y={count()} fill="island" />
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel wide">
				<h3>3. Flat children, faceted by species</h3>
				<p class="desc">One declaration of each: every cell has its frame and both axes, once.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="island" yLabel="count" fx="species">
						<Frame />
						<Grid axis="y" />
						<AxisLeft />
						<AxisBottom />
						<BarMarkY table="penguins" x="island" y={count()} fill="island" />
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>4. Flat children + a foreground snippet</h3>
				<p class="desc">Mixing works: the crosshair stays in its snippet until overlays move.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="island" yLabel="count">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<BarMarkY table="penguins" x="island" y={count()} fill="island" />
						{#snippet foreground()}
							<Crosshair />
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel">
				<h3>5. canvas snippet + children</h3>
				<p class="desc">
					Mixing works: the children render in the snippet's canvas. The bars (children) draw on the
					grid (snippet), with axes and frame. No warning.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="island" yLabel="count">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<BarMarkY table="penguins" x="island" y={count()} fill="island" />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			{#if misuse}
				<div class="chart-panel">
					<h3>6. Misuse (?misuse=1)</h3>
					<p class="desc">
						A crosshair as a child: a warning to keep it in the foreground snippet, and it doesn't
						draw. Everything else draws.
					</p>
					<div class="chart-wrapper">
						<ChartContainer xLabel="island" yLabel="count">
							<Frame />
							<AxisLeft />
							<AxisBottom />
							<Crosshair />
							<BarMarkY table="penguins" x="island" y={count()} fill="island" />
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<Grid axis="y" />
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.container {
		padding: 20px;
	}

	.subtitle,
	.desc {
		color: #666;
		font-size: 13px;
	}

	.charts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
		gap: 24px;
	}

	.chart-panel.wide {
		grid-column: 1 / -1;
	}

	.chart-wrapper {
		height: 280px;
	}

	.status {
		padding: 20px;
	}

	.error {
		color: #c00;
	}
</style>
