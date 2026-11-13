<script>
	/**
	 * Chart entrances: what each mark does when its chart's data first draws.
	 *
	 * 'auto': bars, histograms, areas and their outlines grow from 0 on the
	 * measure axis; dots, lines, rules and text fade. 'fade': everything fades.
	 * 'none': everything appears at once. The axes never move on load.
	 *
	 * The two slow-rule charts show the gate: a chart waits for its marks' first
	 * data (at most a second past the first) so later extents cannot move the axes
	 * mid-entrance; holdsEntrance={false} lets a known-slow mark not hold it.
	 *
	 * Replay remounts every chart. With the OS set to reduce motion, 'auto'
	 * fades instead of growing.
	 */
	import * as msql from '@uwdata/mosaic-sql';
	import { count, avg } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		WebGPUCanvas,
		BarMarkY,
		BarMarkX,
		RectYMark,
		AreaMarkY,
		LineMark,
		DotsMark,
		TextMark,
		RuleMarkY
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import { bin } from '$lib/sql/bin';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);
	let mode = $state('auto');
	let replay = $state(0);
	// Off by default: DuckDB-WASM runs one query at a time, so the slow mark's
	// reads delay every other chart's queries too, not only its own chart.
	let showSlow = $state(false);

	const reducedMotion =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	onMount(async () => {
		try {
			await queryEngine.exec(
				msql.loadParquet('penguins', `${location.origin}/data/penguins.parquet`).toString()
			);
			await queryEngine.exec(
				msql
					.loadCSV('unemployment', `${location.origin}/data/bls-industry-unemployment.csv`)
					.toString()
			);
			// A deliberately slow mark: a rule at 200, above every bar, so it
			// widens the y domain, computed over 15M rows each time it is read (about half a second in WASM; past the one-second cap the waited-for chart enters without it too).
			await queryEngine.exec(`
				CREATE VIEW slow_rule AS
				SELECT 200 + 0 * avg(hash(i) % 1000) AS v FROM range(15000000) t(i)
			`);
			isLoaded = true;
		} catch (error) {
			console.error(error);
			loadError = error.message;
		}
	});
</script>

<div class="page">
	<header>
		<label>
			entrance
			<select bind:value={mode} onchange={() => replay++}>
				<option value="auto">auto</option>
				<option value="fade">fade</option>
				<option value="none">none</option>
			</select>
		</label>
		<button onclick={() => replay++}>Replay</button>
		<label>
			<input type="checkbox" bind:checked={showSlow} onchange={() => replay++} />
			slow-mark charts (delays every chart: one DuckDB worker)
		</label>
		<span class="note">prefers-reduced-motion: {reducedMotion ? 'reduce' : 'no preference'}</span>
	</header>

	{#if loadError}
		<p>Error: {loadError}</p>
	{:else if !isLoaded}
		<p>Loading…</p>
	{:else}
		{#key replay}
			<div class="grid">
				<section>
					<h2>Bars, with labels (grow / fade)</h2>
					<div class="chart">
						<ChartContainer xLabel="species" yLabel="count" entrance={mode}>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<Grid />
										<BarMarkY table="penguins" x="species" y={count()} />
										<TextMark table="penguins" x="species" y={count()} text={count()} dy={-8} />
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section>
					<h2>Stacked bars (grow as one block)</h2>
					<div class="chart">
						<ChartContainer xLabel="island" yLabel="count" entrance={mode}>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<BarMarkY table="penguins" x="island" y={count()} fill="species" />
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section>
					<h2>Horizontal bars (grow along x)</h2>
					<div class="chart">
						<ChartContainer xLabel="mean body mass" yLabel="species" entrance={mode}>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<BarMarkX table="penguins" y="species" x={avg('body_mass')} />
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section>
					<h2>Histogram (grow)</h2>
					<div class="chart">
						<ChartContainer xLabel="body_mass" yLabel="count" entrance={mode}>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<RectYMark table="penguins" x={bin('body_mass')} y={count()} />
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section>
					<h2>Stacked area with outline (grow)</h2>
					<div class="chart">
						<ChartContainer xLabel="date" yLabel="unemployed" entrance={mode}>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<AreaMarkY
											table="unemployment"
											x="date"
											y="unemployed"
											fill="industry"
											fillOpacity={0.6}
											stroke="#333"
											strokeWidth={0.5}
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section>
					<h2>Lines with a reference rule (fade)</h2>
					<div class="chart">
						<ChartContainer xLabel="date" yLabel="unemployed" entrance={mode}>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<Grid />
										<LineMark
											table="unemployment"
											x="date"
											y="unemployed"
											stroke="industry"
											strokeWidth={1.5}
										/>
										<RuleMarkY table="unemployment" y={avg('unemployed')} stroke="#c00" />
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				<section>
					<h2>Scatter (fade)</h2>
					<div class="chart">
						<ChartContainer xLabel="bill_length" yLabel="bill_depth" entrance={mode}>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<DotsMark
											table="penguins"
											x="bill_length"
											y="bill_depth"
											fill="species"
											r={3}
										/>
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>

				{#if showSlow}
					{#each [{ title: 'Slow rule, waited for (enters whole, axis already at 200)', holds: true }, { title: 'Slow rule with holdsEntrance={false} (bars enter, rule appears later)', holds: false }] as variant (variant.holds)}
						<section>
							<h2>{variant.title}</h2>
							<div class="chart">
								<ChartContainer xLabel="species" yLabel="count" entrance={mode}>
									{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
									{#snippet canvas()}
										<WebGPUCanvas>
											{#snippet canvasComponents()}
												<BarMarkY table="penguins" x="species" y={count()} />
												<RuleMarkY
													table="slow_rule"
													y="v"
													stroke="#c00"
													holdsEntrance={variant.holds}
												/>
											{/snippet}
										</WebGPUCanvas>
									{/snippet}
								</ChartContainer>
							</div>
						</section>
					{/each}
				{/if}

				<section class="wide">
					<h2>Facets, histograms per species (every cell grows on one curve)</h2>
					<div class="chart">
						<ChartContainer fx="species" entrance={mode}>
							{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<RectYMark table="penguins" x={bin('flipper_length')} y={count()} fill="sex" />
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>
			</div>
		{/key}
	{/if}
</div>

<style>
	.page {
		padding: 1.5rem;
		font-family: system-ui, sans-serif;
	}
	header {
		display: flex;
		gap: 1rem;
		align-items: center;
		margin-bottom: 1rem;
	}
	.note {
		color: #666;
		font-size: 0.85rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, 520px);
		gap: 1.5rem;
	}
	.wide {
		grid-column: 1 / -1;
	}
	.chart {
		width: 100%;
		height: 280px;
	}
	.wide .chart {
		width: 1064px;
	}
	h2 {
		font-size: 0.95rem;
		font-weight: 500;
	}
</style>
