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
	//   C4  Q1 answered: enter and leave TRAVEL, from beyond the end.
	//       -> Chart 2 animates cleanly: a leaver walks off the end while its
	//          replacement climbs in behind it, and they cross at the cutoff.
	//       -> Chart 3 finally moves at all. Changing k only appends or removes
	//          at the TAIL, so no survivor ever changes slot and C3 left it
	//          completely still; the entrant sliding in is the only motion that
	//          chart can show until Q2 is answered.
	//       -> Still expect the axis to re-lay-out in ONE frame underneath the
	//          motion, because categoryCount does not animate. That is Q2, and
	//          seeing it under a moving bar is the point of chart 3.
	//
	//   C5  Q2 answered: categoryCount.
	//       -> Chart 3 correct.
	//
	// STILL OPEN AFTER C4, and neither is a spring bug:
	//   - chart 1's axis labels jump to the final order while the bars travel.
	//     The axis reads #domain, which is display ORDER, rather than
	//     slotCurrent. §9.5's "one source of truth, not a mirror" is the fix and
	//     it is a rung of its own.
	//   - a category can only enter and leave at the FAR end. That is right for
	//     topN, where membership changes at the cutoff, and it is a real
	//     limitation for anything else — an explicit domain that drops a middle
	//     category will send it out the long way.
	//   - a leaver's ROW is gone from a topN result, so there is no vertex to
	//     draw travelling. C4 gives it a position and the mark has nothing to
	//     put there: chart 2 shows the grid line leave while the bar simply
	//     disappears. Chart 4 is the case that matters — the value moves INTO
	//     Other rather than out of the chart — and neither can animate until the
	//     mark keeps outgoing rows alive for the length of a transition. That is
	//     mark-level work; `crossfade_transitions_for_rebinning.md` already
	//     proposes the mechanism for a different trigger.
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
	// WHY ONLY CHART 1 HAS A `sort` PROP. It is the one with no transform, so
	// nothing else can order it. Charts 2, 3 and 4 are topN marks, and topNSimple
	// already returns its rows ranked by value descending — for the CURRENTLY
	// FILTERED data, which is what a racing bar chart is. With the sidecar no
	// longer overwriting display order for an unsorted mark, that data order is
	// what reaches the axis, and it is correct.
	//
	// Adding `sort` to them is actively wrong, which is how it was written first:
	// the sidecar ranks with `Query.from(table)` and NO filter, so chart 2 was
	// ordered by each category's total across all three steps rather than by the
	// step on screen. A fixed ranking with membership churn is not the thing
	// under test.
	//
	// The sidecar ignoring the mark's filter is deliberate for topN's own use
	// (rank the full dataset, display the survivors — see setSortOrder), and it
	// is a real gap for a racing chart, where the ranking has to follow the
	// filter. Not fixed here; recorded so the next person does not "fix" these
	// charts by adding sort back.
	//
	// NO STATE READOUT. There was one — a table of domain, displayOrder,
	// slotTarget, slotCurrent, sortOrder and extents, sampled per chart. It never
	// populated a single cell and was removed. Whatever replaces it has to prove
	// it renders BEFORE it is used to answer a question, because a diagnostic
	// that silently shows nothing is worse than no diagnostic: it absorbs the
	// attention that would otherwise go on the bug.
	//
	// Instead, three console handles, defined below: bandOrder() for the
	// display-order inputs and outputs per axis, allScales() for the raw
	// registry, lastSQL(match) for the queries the engine actually ran.
	//
	// NOT keyed by column name, which this comment used to claim and which cost
	// a round trip: every band scale here is named "category" — the CHANNEL, not
	// the field — and they are kept apart by `sourceField` inside the config
	// half of the registry key. bandOrder() matches on either.
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

	const { queryEngine, filterGroups, scaleRegistry } = initDivePlot();

	// Capture every SQL string the engine runs, so the query the APP sends can be
	// compared against the one the integration test asserts. Those are assembled
	// by the same function but from different parts, and topn-parity builds its
	// parts by hand — so "verified against DuckDB" does not establish that the
	// app's query carries the same ORDER BY.
	//
	// Wrapped at the instance, before any query runs. The engine's own internals
	// call this.query(), which resolves to this property.
	const _sqlLog = [];
	const _origQuery = queryEngine.query.bind(queryEngine);
	queryEngine.query = (q, opts) => {
		_sqlLog.push({ caller: opts?.callerId ?? null, sql: String(q) });
		return _origQuery(q, opts);
	};
	/** lastSQL('race_churn') — most recent first. No arg: everything. */
	function lastSQL(match) {
		const hits = match ? _sqlLog.filter((e) => e.sql.includes(match)) : _sqlLog.slice();
		return hits.reverse().map((e) => `/* caller=${e.caller} */\n${e.sql}`);
	}

	// A console handle, because the header's "read the scale directly from the
	// console" was never actionable: nothing in the codebase puts the registry
	// on `window`. This is the replacement for the removed state readout
	// (§33.5), and it is deliberately a FUNCTION returning plain objects rather
	// than a rendered table — console.table proves it printed, which is the one
	// thing the panel could never do.
	//
	//   bandOrder()            every band axis on this page
	//   bandOrder('cat_churn') just chart 2's
	//
	// #sortOrder and #explicitDomain are the INPUTS updateDomainFromExtents
	// resolves before appending from #extents, so a preferred order that nobody
	// asked for shows up here as a non-null `sortOrder` — which is the whole
	// question §33.4 has failed to answer by looking at bars.
	// Enumerate rather than look up. getScaleByField(f, 'band') returned null for
	// all four columns on the first run and could not say WHY — wrong bucket key,
	// wrong name, or an empty registry are three very different problems and it
	// reported them identically. That is the failure mode that made the removed
	// state readout worthless, reproduced in its replacement.
	//
	// So: walk every bucket, report every scale it holds, and match by name OR
	// sourceField. If nothing matches, the inventory IS the answer.
	function allScales() {
		const found = [];
		for (const [bucket, map] of Object.entries(scaleRegistry.scales ?? {})) {
			for (const [key, scale] of map) {
				found.push({ bucket, key, name: scale.name, sourceField: scale.sourceField, scale });
			}
		}
		return found;
	}

	function bandOrder(field) {
		const inventory = allScales();
		const fields = field ? [field] : ['cat_reorder', 'cat_churn', 'cat_count', 'cat_other'];
		const out = {};
		for (const f of fields) {
			const hit = inventory.find((s) => s.name === f || s.sourceField === f);
			const scale = hit?.scale;
			if (!scale?.getDebugInfo) {
				out[f] = 'not found';
				continue;
			}
			const d = scale.getDebugInfo();
			// categoryAt is the public decode — ids in, source values out. Every
			// one of these arrays is in id space once identity has arrived.
			const label = (id) => scale.categoryAt(id) ?? `#${id}`;
			out[f] = {
				displayed: d.displayOrder.map(label).join(', '),
				sortOrder: d.sortOrder ? d.sortOrder.map(label).join(', ') : null,
				explicitDomain: d.explicitDomain ? d.explicitDomain.map(label).join(', ') : null,
				extents: Object.values(d.extents)
					.map((ids) => ids.map(label).join(', '))
					.join(' | '),
				currentDomain: d.currentDomain.join(', '),
				slotTarget: Array.from(d.slotTarget).join(', '),
				slotCurrent: Array.from(d.slotCurrent).join(', ')
			};
		}
		// Always carry the inventory, so a miss is self-explaining instead of
		// being another question.
		out._registry = allScales().map((s) => `${s.bucket} | ${s.key} | name=${s.name}`);
		return out;
	}
	if (typeof window !== 'undefined') {
		window.bandOrder = bandOrder;
		window.allScales = allScales;
		window.lastSQL = lastSQL;
		window.scaleRegistry = scaleRegistry;
	}
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

				// Chart 4. Other's height is deliberately DIFFERENT at every step
				// (15, 33, 18), because a bucket that absorbs a leaver without
				// changing size cannot be seen absorbing anything — the fixture
				// mistake `0f86cc4` records. The first draft of this table had
				// Other at 30 in all three steps.
				`CREATE TABLE race_other AS
				   SELECT v.cat AS cat_other, v.step AS step
				   FROM (VALUES
				     ('A',1,50),('B',1,40),('C',1,30),('D',1,10),('E',1,5),
				     ('A',2,50),('B',2,40),('C',2,8),('D',2,35),('E',2,25),
				     ('A',3,6),('B',3,40),('C',3,12),('D',3,50),('E',3,45)
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
				<h2>4. Membership with an Other bucket — topN(3, includeOthers)</h2>
				<p>
					The same churn as chart 2, but nothing leaves the chart: a category dropping out of the
					top three is absorbed into <strong>Other</strong>, whose height changes to prove it (15,
					33, 18). This is the case a leaver has somewhere to GO — Other is a real bucket with a
					real slot and a reserved dim id — so the exit has a destination rather than just an exit
					direction. Shares chart 2's step buttons.
				</p>
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
										table="race_other"
										x="cat_other"
										y={count()}
										selection="band-race"
										transforms={[topN(3, { includeOthers: true })]}
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
				<tr><td>4</td><td>step 1</td><td>A 50, B 40, C 30, Other 15</td></tr>
				<tr><td>4</td><td>step 2</td><td>A 50, B 40, D 35, Other 33</td></tr>
				<tr><td>4</td><td>step 3</td><td>D 50, E 45, B 40, Other 18</td></tr>
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
