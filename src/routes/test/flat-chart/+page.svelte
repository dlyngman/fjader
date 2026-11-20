<script>
	/**
	 * Flat charts: a chart's components as ChartContainer's children, no
	 * snippets. Each case says what should happen; compare 1 with 2 and 3.
	 *
	 *   ?paintlog=1  puts a tall facet grid (12 cells, most below the fold) first,
	 *              with a paint counter per cell: does a canvas scrolled out of
	 *              view still get paint events when its strings change?
	 *   ?misuse=1  adds case 6: an overlay placed where it can't draw, for the
	 *              console warning (open DevTools first)
	 */
	import { count, sum, loadParquet } from '@uwdata/mosaic-sql';
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
		Crosshair,
		Labels,
		TextMark
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';

	const { queryEngine } = initFjader();
	const misuse = page.url.searchParams.get('misuse') === '1';
	const paintlog = page.url.searchParams.get('paintlog') === '1';

	// --- ?paintlog=1: paint events per facet cell ---
	let gridEl = $state();
	let measureSum = $state(false);
	/** Per cell canvas, in grid order: paints since counting started, and where it was. */
	let cells = $state([]);
	let changes = $state(0);

	function startCounting() {
		const canvases = [...gridEl.querySelectorAll('canvas')];
		cells = canvases.map(() => ({ paints: 0, top: 0 }));
		canvases.forEach((canvas, i) =>
			canvas.addEventListener('paint', () => {
				cells[i].paints++;
			})
		);
		snapshot(canvases);
	}

	/** Each cell's position now, and whether it is in the viewport. */
	function snapshot(canvases = [...gridEl.querySelectorAll('canvas')]) {
		canvases.forEach((canvas, i) => {
			if (cells[i]) cells[i].top = Math.round(canvas.getBoundingClientRect().top);
		});
	}

	/** Hide or show the first cell's canvas (display: none): it gets no paint events while hidden. */
	let firstHidden = $state(false);
	function toggleFirstCell() {
		const layer = gridEl.querySelector('canvas').parentElement;
		firstHidden = !firstHidden;
		layer.style.display = firstHidden ? 'none' : '';
	}

	function changeLabels() {
		snapshot();
		for (const cell of cells) cell.paints = 0;
		changes++;
		measureSum = !measureSum;
	}
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec([
				loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString()
			]);
			if (paintlog) {
				await queryEngine.exec(`
					CREATE TABLE facet_many AS
					SELECT 'group ' || lpad(CAST(i % 12 AS VARCHAR), 2, '0') AS grp,
						'c' || CAST(i % 5 AS VARCHAR) AS cat,
						(i * 7919) % 100 AS v
					FROM range(600) t(i)
				`);
			}
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

		{#if paintlog}
			<div class="paintlog">
				<button onclick={startCounting}>1. Start counting</button>
				<button onclick={changeLabels} disabled={cells.length === 0}>2. Change every label</button>
				<button onclick={toggleFirstCell} disabled={cells.length === 0}
					>3. {firstHidden ? 'Show' : 'Hide'} first cell</button
				>
				<span>changes: {changes}</span>
				<table>
					<thead><tr><th>cell</th><th>top (px)</th><th>in view</th><th>paints</th></tr></thead>
					<tbody>
						{#each cells as cell, i (i)}
							<tr>
								<td>{i}</td>
								<td>{cell.top}</td>
								<td>{cell.top < innerHeight && cell.top > -280 ? 'yes' : 'no'}</td>
								<td>{cell.paints}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="chart-panel">
				<h3>Paint log: 12 facet cells, most below the fold</h3>
				<p class="desc">
					Stay at the top. Press 1 once the grid has drawn, then 2: every label's string changes. Do
					the offscreen cells' paint counts move? Do the visible cells' labels update? Then 3 hides
					the first cell (display: none); press 2 again: the other cells' labels must still update,
					though the hidden cell no longer paints.
				</p>
				<div class="tall-grid" bind:this={gridEl}>
					<ChartContainer
						xLabel="cat"
						yLabel={measureSum ? 'sum of v' : 'count'}
						fx="grp"
						columns={2}
					>
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<BarMarkY table="facet_many" x="cat" y={measureSum ? sum('v') : count()} fill="cat"
							><Labels anchor="inside-end" /></BarMarkY
						>
					</ChartContainer>
				</div>
			</div>
		{/if}
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

			<div class="chart-panel">
				<h3>7. Labels and TextMark, not faceted (control)</h3>
				<p class="desc">
					Counts inside the bars' tops (&lt;Labels anchor="inside-end"&gt;) and island names above
					the bars (TextMark).
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="island" yLabel="count">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<BarMarkY table="penguins" x="island" y={count()} fill="island"
							><Labels anchor="inside-end" /></BarMarkY
						>
						<TextMark table="penguins" x="island" y={count()} text="island" dy={-14} fontSize={9} />
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel wide">
				<h3>8. Labels and TextMark, faceted, with snippets</h3>
				<p class="desc">
					As charts are written today. Counts (&lt;Labels&gt;) in every species cell, each cell its
					own. The island names (TextMark) don't draw in facet grids yet.
				</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="island" yLabel="count" fx="species">
						{#snippet background()}
							<Frame />
							<AxisLeft />
							<AxisBottom />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<BarMarkY table="penguins" x="island" y={count()} fill="island"
										><Labels anchor="inside-end" /></BarMarkY
									>
									<TextMark
										table="penguins"
										x="island"
										y={count()}
										text="island"
										dy={-14}
										fontSize={9}
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</div>

			<div class="chart-panel wide">
				<h3>9. Labels and TextMark, faceted, as children</h3>
				<p class="desc">The same, flat.</p>
				<div class="chart-wrapper">
					<ChartContainer xLabel="island" yLabel="count" fx="species">
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<BarMarkY table="penguins" x="island" y={count()} fill="island"
							><Labels anchor="inside-end" /></BarMarkY
						>
						<TextMark table="penguins" x="island" y={count()} text="island" dy={-14} fontSize={9} />
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
	.paintlog {
		position: fixed;
		top: 8px;
		right: 8px;
		z-index: 100;
		background: var(--fjader-bg, #fff);
		border: 1px solid #999;
		padding: 8px;
		font-size: 12px;
		max-height: 90vh;
		overflow: auto;
	}

	.paintlog td,
	.paintlog th {
		padding: 0 6px;
		text-align: right;
	}

	.tall-grid {
		height: 2400px;
	}
</style>
