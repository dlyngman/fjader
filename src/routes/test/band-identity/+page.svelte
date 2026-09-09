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
	// Every mark below carries an explicit `tip` naming its band channel, so
	// the decoded category is ON SCREEN rather than something you have to infer
	// from bar heights. Tooltips are on by default; the point of spelling `tip`
	// out is that a wrong decode is then unmissable instead of merely available.
	//
	// WHAT A BAND TOOLTIP IS ACTUALLY TESTING. The channel holds an identity
	// id; invertScreenToData and the d3 band scale both work in display slots.
	// TooltipManager translates between them (its BAND IDENTITY section), so a
	// bug there shows up in three distinguishable ways:
	//
	//   - hover a bar, get ANOTHER bar's numbers  -> hit-test compared slot to
	//     id (#buildHitTestQuery / #buildNearestQuery)
	//   - right numbers, wrong category NAME      -> label decode indexed the
	//     display domain with an id (#resolveValue)
	//   - right tooltip, indicator on the wrong
	//     bar                                     -> #resolveScreenPos
	//
	// Charts 1 and 5 CANNOT catch any of this: they are in dim order, where
	// slot == id and every wrong lookup returns the right answer anyway. Charts
	// 2, 3 and 4 are the ones that matter — hover EVERY bar in each, not just
	// the first, since slot 0 also agrees with id 0 in chart 2.
	//
	// CHART 6 is not part of the checkpoint sequence. It covers §16.10 item 1:
	// a band axis backed by a fixed SQL expression, dimmed on the expression
	// text rather than a column name. Its table has NO categorical column — the
	// categories are the CASE's output — so it exercises the path where the map
	// key and the emitted SQL had to be separated. Its explicit domain also
	// makes slot != id, so a decode bug shows there the same way it does in 2-4.
	// What to look for: three bars in Light, Medium, Heavy order, labels
	// matching, and tooltips naming the right class.
	//
	// CHART 7 is also outside the checkpoint sequence. It covers §20.4 A: a band
	// axis over an INTEGER column, where the dim holds NUMBERS. Everything below
	// assumes a category is a string, and the round trip only worked because
	// both sides of every lookup come from the same driver — d3 resolves
	// scale(2021) and returns undefined for scale('2021'), so a value coerced
	// anywhere on the way through pins every label at pixel 0. Its reversed
	// explicit domain makes slot != id, so decode bugs show as in 2-4.
	// What to look for: bars labelled 2023, 2022, 2021, 2020 in that order.
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
	import { loadParquet, count, sql } from '@uwdata/mosaic-sql';
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
				`CREATE TABLE band_shared_b AS SELECT 'Emperor' AS cat_shared FROM range(60)`,
				// Chart 6: a fixed expression over a numeric column. No categorical
				// column at all — the categories exist only as the CASE's output.
				`CREATE TABLE band_expr AS SELECT body_mass AS mass_expr FROM penguins WHERE body_mass IS NOT NULL`,
				// Chart 7: an INTEGER band column. The dim keeps NUMBERS, not
				// strings, and d3's scaleBand looks its domain up by the raw value
				// — scale(2021) resolves, scale('2021') does not — so a value
				// stringified anywhere on the way through pins every label at
				// pixel 0. Nothing covered this until §20.4 A.
				`CREATE TABLE band_numeric AS SELECT 2020 + (CAST(bill_length AS INTEGER) % 4) AS yr_numeric
				   FROM penguins WHERE bill_length IS NOT NULL`
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
		top of this file. Hover every bar of charts 2, 3, 4 and 6: those are the ones where a band slot
		and a dim id disagree, so they are the only ones a tooltip decode bug shows up in.
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
									<BarMarkY table="band_plain" x="cat_plain" y={count()} tip={['x', 'y']} />
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
										tip={['x', 'y']}
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
										tip={['x', 'y']}
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
									<BarMarkY
										table="band_topn"
										x="cat_topn"
										y={count()}
										transforms={[topN(2)]}
										tip={['x', 'y']}
									/>
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
									<BarMarkX table="band_shared_a" y="cat_shared" x={count()} tip={['y', 'x']} />
									<BarMarkX table="band_shared_b" y="cat_shared" x={count()} tip={['y', 'x']} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</section>

			<section>
				<h2>6. Fixed SQL expression</h2>
				<p>
					A CASE over a numeric column — the categories exist only as its output (§16). Dimmed on
					the expression text; <code>domain</code> supplies the order, since ids are alphabetical. Expect
					Light, Medium, Heavy.
				</p>
				<div class="chart">
					<ChartContainer xLabel="weight class" yLabel="count">
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
										table="band_expr"
										x={sql`CASE WHEN mass_expr < 3700 THEN 'Light'
										             WHEN mass_expr < 4500 THEN 'Medium'
										             ELSE 'Heavy' END`}
										y={count()}
										domain={{ x: ['Light', 'Medium', 'Heavy'] }}
										tip={['x', 'y']}
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</section>

			<section>
				<h2>7. Numeric band column</h2>
				<p>
					An INTEGER axis, with <code>domain</code> reversing it so slot != id. The dim holds numbers
					rather than strings (§20.4 A), and d3 resolves its domain by the raw value — a stringified
					one silently returns undefined. What to look for: four bars labelled 2023, 2022, 2021, 2020
					in that order, labels matching their bars, and tooltips naming the year under the cursor rather
					than its neighbour.
				</p>
				<div class="chart">
					<ChartContainer xLabel="year" yLabel="count">
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
										table="band_numeric"
										x="yr_numeric"
										y={count()}
										domain={{ x: [2023, 2022, 2021, 2020] }}
										tip={['x', 'y']}
									/>
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
