<script>
	// Verification harness for band step 3a — the migration from CASE-inlined
	// category indices to dim-table identity ids
	// (proposals/review_band_category_index_architecture.md §9).
	//
	// The migration lands in checkpoints, and each one has a different expected
	// result on this page. Keep it open through all of them:
	//
	//   C0  ensureColumns wiring, queries unchanged
	//       -> NOTHING on this page changes. Purely additive.
	//
	//   C1  band domain sourced from the dim (ORDER BY id)
	//       -> "Plain" and "Shared scale" go alphabetical. Today their order is
	//          whatever SELECT DISTINCT returned (updateDomainFromExtents:419
	//          falls back to first-appearance order), so this is arbitrary ->
	//          deterministic, not correct -> wrong.
	//       -> "Sorted", "Explicit domain" and "topN" are UNCHANGED: an explicit
	//          domain or sort order still wins in updateDomainFromExtents.
	//
	//   C2  queries select the view's id column instead of a CASE
	//       -> PIXEL-IDENTICAL to C1 for "Plain" and "Shared scale", because C1
	//          made position-in-domain equal to the dim id for exactly those.
	//          Any movement here means the plumbing is wrong.
	//       -> "Sorted", "Explicit domain" and "topN" render ALPHABETICALLY.
	//          Expected and temporary: id != slot until C3.
	//
	//   C3  slot table + shader lookup
	//       -> All five correct. This is the rung that ends the alphabetical
	//          interval.
	//
	//   C4  dead code deleted (caseExpression, skipBandIndex, #processWithMap,
	//       tooltip CASE/Map paths)
	//       -> No change. Deletion only.
	//
	// Check tooltips at every rung, not just the bars: the tooltip has its own
	// CASE path (Path A) and Map path (Path B), and both are on the deletion
	// list. A bar in the right place with a wrong tooltip is the failure this
	// page exists to catch.
	//
	// WHY EVERY CHART USES ITS OWN FIELD NAME. ScaleRegistry keys scales by
	// `${name}-${type}${configKey}` (ScaleRegistry.svelte.ts:247) — field name
	// plus type plus config, NOT per chart or per table (§3.4). Five charts on
	// `species` therefore share ONE BandScaleState: chart 3's explicit domain
	// would set #explicitDomain for all of them (it beats #sortOrder in
	// updateDomainFromExtents:411, silently killing chart 2's sort), and chart
	// 5's extra category would appear in every chart's domain. So each
	// configuration below reads a distinctly-named column and gets its own
	// scale. Chart 5 is the deliberate exception: two marks, two tables, one
	// shared field — that IS the case under test.

	import { onMount } from 'svelte';
	import { loadParquet, count } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		BarMarkY,
		BarMarkX
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import { topN } from '$lib/transforms';

	const { queryEngine } = initDivePlot();
	let isLoaded = $state(false);
	let error = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec(
				loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`).toString()
			);

			// One table per configuration, each with its own column name, so the
			// five scales stay independent. See the note above.
			await queryEngine.exec([
				`CREATE TABLE band_plain    AS SELECT species AS cat_plain    FROM penguins`,
				`CREATE TABLE band_sorted   AS SELECT species AS cat_sorted   FROM penguins`,
				`CREATE TABLE band_explicit AS SELECT species AS cat_explicit FROM penguins`,
				`CREATE TABLE band_topn     AS SELECT island  AS cat_topn     FROM penguins`,
				// Two tables, ONE field: the shared-scale + dim-append case.
				// Emperor exists only in the second, so the dim must APPEND it with
				// a new id and neither mark may renumber. §9.4 warns a per-scale
				// label copy breaks exactly here — blank labels in multi-table
				// charts — so watch for a bar with no label.
				`CREATE TABLE band_shared_a AS SELECT species AS cat_shared FROM penguins`,
				`CREATE TABLE band_shared_b AS SELECT 'Emperor' AS cat_shared FROM range(60)`
			]);

			isLoaded = true;
		} catch (e) {
			error = String(e);
		}
	});
</script>

<div class="page">
	<h1>Band identity — step 3a verification</h1>
	<p class="note">
		Five band configurations. The expected result differs per checkpoint — see the comment at the
		top of this file. Hover every chart: the tooltip has its own index path.
	</p>

	{#if error}
		<pre class="error">{error}</pre>
	{:else if !isLoaded}
		<p>Loading…</p>
	{:else}
		<div class="grid">
			<section>
				<h2>1. Plain</h2>
				<p>
					No sort, no domain, no transform. <strong>C1</strong>: becomes alphabetical.
					<strong>C2</strong>: must not move.
				</p>
				<div class="chart">
					<ChartContainer xLabel="species" yLabel="count">
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
									<BarMarkY table="band_plain" x="cat_plain" y={count()} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</section>

			<section>
				<h2>2. Sorted by count, desc</h2>
				<p>
					Sort the x band axis by the y channel. Expect Adelie, Gentoo, Chinstrap (152, 124, 68). <strong
						>C2</strong
					>: expected to go alphabetical.
					<strong>C3</strong>: back to count order.
				</p>
				<div class="chart">
					<ChartContainer xLabel="species" yLabel="count">
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
										table="band_sorted"
										x="cat_sorted"
										y={count()}
										sort={{ x: 'y', order: 'desc' }}
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</section>

			<section>
				<h2>3. Explicit domain</h2>
				<p>
					Deliberately non-alphabetical: Gentoo, Adelie, Chinstrap. <strong>C3</strong>: must hold
					this exact order.
				</p>
				<div class="chart">
					<ChartContainer xLabel="species" yLabel="count">
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
										table="band_explicit"
										x="cat_explicit"
										y={count()}
										domain={{ x: ['Gentoo', 'Adelie', 'Chinstrap'] }}
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</section>

			<section>
				<h2>4. topN(2) — category-reducing</h2>
				<p>
					The <code>skipBandIndex</code> path, deleted at C4. Domain must contain only the surviving
					categories.
				</p>
				<div class="chart">
					<ChartContainer xLabel="island" yLabel="count">
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
									<BarMarkY table="band_topn" x="cat_topn" y={count()} transforms={[topN(2)]} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</section>

			<section>
				<h2>5. Shared scale, two tables (horizontal)</h2>
				<p>
					Both marks read <code>species</code>; the second table adds Emperor. The dim must APPEND,
					giving Emperor a new id without renumbering. Watch for a missing or blank label — that is
					the §9.4 failure.
				</p>
				<div class="chart">
					<ChartContainer xLabel="count" yLabel="species">
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
									<BarMarkX table="band_shared_a" y="cat_shared" x={count()} />
									<BarMarkX table="band_shared_b" y="cat_shared" x={count()} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</section>
		</div>
	{/if}
</div>

<style>
	.page {
		padding: 1rem 1.5rem;
		font-family: system-ui;
	}

	h1 {
		font-size: 20px;
	}

	h2 {
		font-size: 15px;
		margin: 0 0 2px;
	}

	.note {
		color: #666;
		font-size: 13px;
		max-width: 80ch;
	}

	section p {
		color: #666;
		font-size: 12px;
		margin: 0 0 8px;
		min-height: 2.5em;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
		gap: 20px;
	}

	.chart {
		height: 260px;
	}

	.error {
		color: #b91c1c;
		white-space: pre-wrap;
		font-size: 12px;
	}
</style>
