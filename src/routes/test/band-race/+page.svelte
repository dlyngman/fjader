<script>
	// Verification harness for band step 5 — the animated reorder
	// (proposals/review_band_category_index_architecture.md §9.5, §12, §31.2).
	//
	// This page exists to answer §12's two still-open questions BEFORE a spring
	// is written, because both of them decide data layout that is expensive to
	// retrofit:
	//
	//   Q1  Entering/leaving semantics. A category that leaves the top-N cannot
	//       spring toward -1: ScaleTemplateSystem.ts:224 discards value < 0.0
	//       before the slot lookup, so it would vanish the instant the spring
	//       left its last slot rather than animate out. It needs either a real
	//       slot held until the spring settles or a separate opacity channel —
	//       and an opacity channel changes the packer's block layout and
	//       therefore IDENTITY_SLOT_CAPACITY's budget.
	//
	//   Q2  Does categoryCount animate? §2.1's "interpolating the index is
	//       pixel-correct for free" holds only while categoryCount is constant.
	//       p1 is a per-scale scalar, not per-id.
	//
	// BEFORE ANY OF THAT: NOTHING REORDERS TODAY. Measured, not assumed — at
	// `4dc07a2`, chart 1's buttons change nothing, and the reason is not in this
	// page. §31.2 says "every precondition for step 5 is in". That is true of the
	// identity and slot machinery and false of the thing that drives it: there is
	// no path that moves `displayOrder` after setup.
	//
	//   `sort`    IS reactive — MarkLifecycleV2 has a dedicated $effect (:574)
	//             that re-runs the sidecar on every change. The sidecar queries
	//             correctly and ends at BandScaleState.setSortOrder, which assigns
	//             #sortOrder and stops. It does not call updateDomainFromExtents
	//             and does not schedule one, so #domain, #displayOrder and the
	//             slot table all stay exactly where they were. This is §3.1's
	//             finding and it is STILL LIVE: PR #198 fixed the sidecar's SQL
	//             for computed axes, not the fact that its result is never applied.
	//
	//   `domain`  is NOT reactive. It is read once inside #runSetup's Promise.all
	//             (:740) and applied by fetchCategoricalDomains' deferred
	//             addMark(..., { explicit: true }). Changing the prop afterwards
	//             does nothing at all — no effect watches it. (addMark DOES
	//             schedule a domain update, so the mechanism works; nothing calls
	//             it a second time.)
	//
	// So step 5's first rung is not the spring, and not even slotTarget — it is
	// making a static reorder land at all. §3.1 said "do not fix the re-sort path
	// first, the animated design IS the sort implementation", which is right, but
	// it reads as though the fix arrives WITH step 5. It has to arrive FIRST, or
	// there is nothing for a spring to interpolate between.
	//
	// CHECKPOINTS. Each has a different expected result here. Keep this page
	// open through all of them.
	//
	//   C0  setSortOrder schedules a domain update, so the re-sort path reorders.
	//       No slot table work, no spring.
	//       -> Chart 1's buttons start working, INSTANTLY — bars jump to the new
	//          order with no motion. That jump is the correct result here.
	//       -> Charts 2 and 3 must not change: they are driven by topN and a
	//          filter, not by the sort path.
	//
	//   C1  slotTarget/slotCurrent exist; a reorder retargets them; slotCurrent
	//       is written STRAIGHT THROUGH with no interpolation at all.
	//       -> NOTHING changes from C0. Every button state is pixel-identical.
	//          Purely additive.
	//       -> If anything moves here the wiring is wrong, and that is far
	//          cheaper to find now than through a spring. §3.1: a static reorder
	//          is the same path with the spring snapped to 1.
	//
	//   C2  BandScaleState implements step() / updateRenderState(dt) /
	//       isAtRest() as LinearScaleState:380-403 does, and lands in
	//       GPUCoordinator's #animatedScalesArray. Spring still snapped.
	//       -> Still pixel-identical at rest. What is under test is the LOOP,
	//          not the motion: watch for a chart that redraws forever (isAtRest
	//          never true) and for isAtRest() returning true while slotCurrent
	//          and slotTarget still differ.
	//
	//   C3  The spring actually interpolates.
	//       -> Chart 1 animates between orders. This is the rung it is for.
	//       -> CHARTS 2 AND 3 ARE EXPECTED TO BE WRONG HERE. Membership churn
	//          has no semantics yet, so a leaving category pops. That is Q1
	//          unanswered, and it is the whole point of chart 2 — do not
	//          "fix" it by special-casing here.
	//
	//   C4  Q1 answered: enter/leave.
	//       -> Chart 2 animates cleanly. Chart 3 still suspect.
	//
	//   C5  Q2 answered: categoryCount.
	//       -> Chart 3 correct.
	//
	// HOW IT FAILS, AND WHAT EACH FAILURE MEANS. The value of separating the
	// three charts is that these stay distinguishable:
	//
	//   - a bar JUMPS to its new slot while its neighbours slide
	//       -> slotTarget is written but the shader is not reading slotCurrent:
	//          a stale p4 base, or the packer not seeing the new slotVersion.
	//   - bars slide but AXIS LABELS jump
	//       -> the axis is reading #domain (display order) instead of the
	//          interpolated table. This is exactly the "labels stay put while
	//          bars race" problem §9.5 cites as the reason interpolation is
	//          CPU-side: there is meant to be one source of truth, not a mirror.
	//   - a leaving category VANISHES instantly            -> Q1, expected before C3
	//   - a leaving category draws at the far edge         -> Q1: slotCurrent
	//          sprang toward -1 and the shader discarded it at < 0.0
	//   - everything slides but the axis squashes/stretches -> Q2
	//   - the chart redraws forever after settling          -> isAtRest never true
	//
	// WHY THREE CHARTS AND NOT ONE RACING BAR CHART. A racing chart where the
	// same N categories merely reorder would let a spring ship that is broken
	// for churn, and the failure would be unattributable between reorder,
	// enter/leave and a moving categoryCount. That is the mistake §29.12.3 and
	// `b107def` record — the fix there was to split one chart so each channel
	// was tested on its own. Chart 1 varies ORDER only, chart 2 varies
	// MEMBERSHIP at constant N, chart 3 varies N. Nothing varies two at once.
	//
	// CHART 1 CANNOT CATCH A DECODE BUG in its "alphabetical" state: that is
	// the order the dim assigns ids in, so slot == id and every wrong lookup
	// returns the right answer anyway. Use its other two orders, and hover the
	// bars rather than trusting their heights.
	//
	// WHY BUTTONS AND NOT A TIMER. A timer makes this look like a racing bar
	// chart and makes every failure a stopwatch problem. These questions are
	// about semantics, not pacing: each button is a single deterministic
	// transition that can be re-run and stared at. Add the timer once Q1 and Q2
	// are settled, not before.
	//
	// WHY EVERY CHART USES ITS OWN COLUMN NAME. ScaleRegistry keys scales by
	// `${name}-${type}${configKey}` (ScaleRegistry.svelte.ts:247) — field name
	// plus type plus config, NOT per chart or per table (§3.4). Three charts on
	// one column name would share ONE BandScaleState, so chart 1's explicit
	// domain would silently reorder charts 2 and 3 as well.
	//
	// AN OPEN RISK IN CHART 3. It changes topN's `k` through a prop. If that
	// tears the mark down and rebuilds it, you will see a teardown and a
	// re-entry rather than an animation, and Q2 will need the lazy-node
	// treatment AutoBinNode uses for LOD-scrubbable params rather than a prop.
	// Establish which it is before reading anything else into chart 3.

	import { onMount } from 'svelte';
	import { sql } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		BarMarkY
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import { topN } from '$lib/transforms';
	import { count } from '@uwdata/mosaic-sql';

	const { queryEngine, filterGroups } = initDivePlot();
	let isLoaded = $state(false);
	let error = $state(null);

	// --- Chart 1: order only -------------------------------------------------
	// Driven by `sort`, NOT by `domain`. The first draft of this page used
	// `domain`, which cannot work: it is a setup-time input (MarkLifecycleV2
	// :740), so changing it after the mark has set up does nothing and no
	// warning is issued. `sort` is the path with a reactive $effect behind it,
	// and it is also the path step 5 has to animate — §3.1 — so driving the
	// harness with it means C3 exercises the real entry point rather than a
	// convenience the feature will not use.
	//
	// Counts are deliberately non-monotonic in the letter, so the three orders
	// are visually distinct. A monotonic fixture would make "alphabetical" and
	// "count asc" the same picture, which is the fixture mistake `0f86cc4`
	// records.
	//   A=30  B=10  C=50  D=20  E=40
	//
	// Sorting by 'x' means sorting by the band column itself, which reproduces
	// dim order — the state where slot == id and a decode bug still looks right.
	const ORDERS = {
		'count desc': { x: 'y', order: 'desc' }, // C E A D B
		'count asc': { x: 'y', order: 'asc' }, // B D A E C
		alphabetical: { x: 'x', order: 'asc' } // A B C D E — slot == id, the blind one
	};
	let orderName = $state('count desc');
	let sortConfig = $state(ORDERS['count desc']);

	function setOrder(name) {
		orderName = name;
		sortConfig = ORDERS[name];
	}

	// --- Chart 2: membership only, N held at 3 -------------------------------
	// Driven by a programmatic filter rather than by swapping the table or the
	// transform, so the mark is never torn down: what changes is which rows the
	// same mark aggregates, which is precisely what a frame of a racing bar
	// chart is.
	//
	//   step 1   A=50 B=40 C=30 D=20 E=10   top3 = A, B, C
	//   step 2   A=50 B=40 C=10 D=35 E=20   top3 = A, B, D   (C out, D in)
	//   step 3   A=10 B=40 C=20 D=50 E=45   top3 = D, E, B   (A out, E in)
	//
	// Exactly one member swaps between 1 and 2, so a single enter/leave can be
	// watched in isolation. 2 -> 3 swaps one more AND reshuffles the survivors,
	// which is the case where a leave and a move happen on the same frame.
	const CHURN_STEPS = [1, 2, 3];
	let churnStep = $state(1);
	const raceGroup = filterGroups.get('band-race');

	function setChurnStep(n) {
		churnStep = n;
		// upsertManual is the documented programmatic entry point (FilterGroup
		// "Manual entries"), so this does not pretend to be an interaction.
		raceGroup.upsertManual('race-step', sql`"step" = ${n}`, n, new Set());
	}

	// --- Chart 3: N only -----------------------------------------------------
	// Same constant data as chart 1, so the only thing moving is how many of it
	// are displayed.
	//   k=2  C,E        k=3  C,E,A        k=4  C,E,A,D        k=5  C,E,A,D,B
	const COUNTS = [2, 3, 4, 5];
	let topCount = $state(3);

	onMount(async () => {
		try {
			// Row counts materialized by joining a counter against a VALUES list,
			// so each category's height is an exact stated number rather than
			// whatever a real dataset happens to hold. A wrong bar is then wrong
			// against a number written down here, not against a memory of the
			// last screenshot.
			await queryEngine.exec([
				`CREATE TABLE race_reorder AS
				   SELECT v.cat AS cat_reorder
				   FROM (VALUES ('A',30),('B',10),('C',50),('D',20),('E',40)) AS v(cat, n)
				   JOIN range(60) r ON r.range < v.n`,

				`CREATE TABLE race_churn AS
				   SELECT v.cat AS cat_churn, v.step AS step
				   FROM (VALUES
				     ('A',1,50),('B',1,40),('C',1,30),('D',1,20),('E',1,10),
				     ('A',2,50),('B',2,40),('C',2,10),('D',2,35),('E',2,20),
				     ('A',3,10),('B',3,40),('C',3,20),('D',3,50),('E',3,45)
				   ) AS v(cat, step, n)
				   JOIN range(60) r ON r.range < v.n`,

				`CREATE TABLE race_count AS
				   SELECT v.cat AS cat_count
				   FROM (VALUES ('A',30),('B',10),('C',50),('D',20),('E',40)) AS v(cat, n)
				   JOIN range(60) r ON r.range < v.n`
			]);

			// Start chart 2 filtered, so its first paint is step 1 rather than
			// the unfiltered union of all three steps — which would show a
			// fourth membership nothing below describes.
			setChurnStep(1);

			isLoaded = true;
		} catch (e) {
			error = String(e);
		}
	});
</script>

<div class="page">
	<h1>Band race — step 5 verification</h1>
	<p class="note">
		Three band configurations, one variable each: <strong>order</strong>,
		<strong>membership</strong>
		, <strong>count</strong>. The expected result differs per checkpoint — see the comment at the
		top of this file. <strong>At <code>4dc07a2</code> chart 1's buttons do nothing</strong> — no
		path moves <code>displayOrder</code> after setup. Fixing that is <strong>C0</strong>, and it
		comes before any spring.
	</p>

	{#if error}
		<pre class="error">{error}</pre>
	{:else if !isLoaded}
		<p>Loading…</p>
	{:else}
		<div class="grid">
			<section>
				<h2>1. Order only</h2>
				<p>
					Same five categories, same five heights, permuted via <code>sort</code>. Membership and
					count are constant, so this is a pure reorder — the <strong>C3</strong> chart.
					<strong>At <code>4dc07a2</code> these buttons do nothing</strong>: the sidecar re-runs and
					<code>setSortOrder</code> stores the result without scheduling a domain update. That is
					what
					<strong>C0</strong> fixes. "alphabetical" is dim order, where slot == id and a decode bug still
					looks right; use the other two.
				</p>
				<div class="controls">
					{#each Object.keys(ORDERS) as name (name)}
						<button class:active={orderName === name} onclick={() => setOrder(name)}>{name}</button>
					{/each}
				</div>
				<div class="chart">
					<ChartContainer xLabel="category" yLabel="count">
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
										table="race_reorder"
										x="cat_reorder"
										y={count()}
										sort={sortConfig}
										tip={['x', 'y']}
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</section>

			<section>
				<h2>2. Membership only — topN(3), N held</h2>
				<p>
					Three bars at every step; which three changes. <strong>1→2</strong> swaps exactly one
					member (C out, D in). <strong>2→3</strong> swaps one more and reshuffles the survivors.
					This is Q1, and it is <em>expected to look wrong</em> at C2.
				</p>
				<div class="controls">
					{#each CHURN_STEPS as n (n)}
						<button class:active={churnStep === n} onclick={() => setChurnStep(n)}>step {n}</button>
					{/each}
				</div>
				<div class="chart">
					<ChartContainer xLabel="category" yLabel="count">
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
										table="race_churn"
										x="cat_churn"
										y={count()}
										selection="band-race"
										transforms={[topN(3)]}
										tip={['x', 'y']}
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</section>

			<section>
				<h2>3. Count only — topN(k)</h2>
				<p>
					Constant data, constant ranking; only how many are shown changes. This is Q2. First
					establish whether changing <code>k</code> animates or tears the mark down and rebuilds it —
					if it rebuilds, Q2 needs a lazy node, not a prop.
				</p>
				<div class="controls">
					{#each COUNTS as k (k)}
						<button class:active={topCount === k} onclick={() => (topCount = k)}>k = {k}</button>
					{/each}
				</div>
				<div class="chart">
					<ChartContainer xLabel="category" yLabel="count">
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
										table="race_count"
										x="cat_count"
										y={count()}
										transforms={[topN(topCount)]}
										tip={['x', 'y']}
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			</section>
		</div>

		<h2 class="expected">Expected contents</h2>
		<table class="expected-table">
			<thead>
				<tr><th>chart</th><th>state</th><th>bars, left to right</th></tr>
			</thead>
			<tbody>
				<tr><td>1</td><td>count desc</td><td>C 50, E 40, A 30, D 20, B 10</td></tr>
				<tr><td>1</td><td>count asc</td><td>B 10, D 20, A 30, E 40, C 50</td></tr>
				<tr><td>1</td><td>alphabetical</td><td>A 30, B 10, C 50, D 20, E 40</td></tr>
				<tr><td>2</td><td>step 1</td><td>A 50, B 40, C 30</td></tr>
				<tr><td>2</td><td>step 2</td><td>A 50, B 40, D 35</td></tr>
				<tr><td>2</td><td>step 3</td><td>D 50, E 45, B 40</td></tr>
				<tr><td>3</td><td>k = 2</td><td>C 50, E 40</td></tr>
				<tr><td>3</td><td>k = 5</td><td>C 50, E 40, A 30, D 20, B 10</td></tr>
			</tbody>
		</table>
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
		min-height: 4em;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
		gap: 20px;
	}

	.chart {
		height: 260px;
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 8px;
	}

	.controls button {
		font: inherit;
		font-size: 12px;
		padding: 3px 9px;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
	}

	.controls button.active {
		background: #1f2937;
		border-color: #1f2937;
		color: #fff;
	}

	.expected {
		margin-top: 28px;
	}

	.expected-table {
		border-collapse: collapse;
		font-size: 12px;
		margin-top: 6px;
	}

	.expected-table th,
	.expected-table td {
		border: 1px solid #ddd;
		padding: 3px 10px;
		text-align: left;
	}

	.expected-table th {
		background: #f6f6f6;
	}

	.error {
		color: #b91c1c;
		white-space: pre-wrap;
		font-size: 12px;
	}
</style>
