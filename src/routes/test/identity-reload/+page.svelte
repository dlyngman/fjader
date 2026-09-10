<script>
	// Verification harness for the identity RELOAD path
	// (proposals/review_band_category_index_architecture.md §20.1, §22.1).
	//
	// WHY THIS ROUTE EXISTS. `clearQueryCache()` drops every identity dim and
	// view, which invalidates the marks' SQL rather than just their results:
	// their query parts still name __dplot_*_idx columns, and #sourceTable falls
	// back to the base table the moment the view registry is cleared. Before
	// `630beb7` nothing told the marks, so every band mark went on emitting SQL
	// for a column its FROM clause no longer had — unrecoverable without a
	// remount.
	//
	// That path had NO in-repo caller. `clearQueryCache()` is documented as the
	// reload entry point for embedders (the Streamlit wrapper), so the whole
	// mechanism — the listener, the mark re-setup, and BandScaleState's
	// object-swap guard — was covered by unit tests and by reasoning, and by
	// nothing you could click. This page is the click.
	//
	// WHAT EACH BUTTON EXERCISES.
	//
	//   Reload (same categories)
	//     The dim is rebuilt from identical data, so ids come back the same.
	//     Everything should look untouched. If the chart empties or throws a
	//     binder error here, the listener or the re-setup is broken outright.
	//
	//   Reload (renumbered)
	//     The reload DROPS a category and ADDS one, so the rebuilt dim numbers
	//     the survivors differently. This is the case §20.1's second half is
	//     about: the scale is holding ids from the old dim, they are still in
	//     RANGE against the new one, and they now mean different categories.
	//     Wrong bars with no error is the failure — watch the labels, not the
	//     bar count.
	//
	//   Reload (shuffled rows, new counts)
	//     Same categories, rows in a different order, different counts. The BAR
	//     HEIGHTS must change and the ORDER must not: the dim assigns ids by
	//     ORDER BY value, and an unsorted band domain reads the dim's values in
	//     id order, so display order comes from the dim and never from row order
	//     (the C1 decision in §9.4 — arbitrary SELECT DISTINCT order became
	//     deterministic dim order). Alphabetical here is the correct answer, not
	//     a reorder that failed to happen.
	//
	//     The counts are what make this button able to fail. It first shipped
	//     with the same counts as the initial load, which made the chart
	//     byte-identical before and after — indistinguishable from a
	//     clearQueryCache() that did nothing whatsoever.
	//
	// WHAT TO LOOK FOR, in all three: four (or three) bars, each label sitting
	// on its own bar, counts matching the table below, and tooltips naming the
	// category under the cursor. Then hit the same button twice — a second
	// reload has to work as well as the first, since the listener has to survive
	// its own re-setup.
	//
	// The counts are deliberately distinct so a mislabelled bar is obvious by
	// height alone rather than needing a tooltip.

	import { onMount } from 'svelte';
	import { count } from '@uwdata/mosaic-sql';
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

	const { queryEngine } = initDivePlot();
	let isLoaded = $state(false);
	let error = $state(null);
	let status = $state('initial load');
	let busy = $state(false);
	let expected = $state('');

	/** Rows as `[category, count]`, expanded into one row per count. */
	const DATASETS = {
		initial: [
			['alpha', 3],
			['bravo', 7],
			['charlie', 11],
			['delta', 5]
		],
		// Same set, same counts. Ids must come back identical.
		same: [
			['alpha', 3],
			['bravo', 7],
			['charlie', 11],
			['delta', 5]
		],
		// charlie is gone and echo is new, so the dim renumbers: the ids the
		// scale is still holding now point at different categories.
		renumbered: [
			['alpha', 4],
			['bravo', 9],
			['delta', 6],
			['echo', 13]
		],
		// Same categories, shuffled rows, and DIFFERENT counts. The counts are what
		// make this button able to fail: with the original counts the chart was
		// byte-identical before and after, so a clearQueryCache() that silently
		// did nothing looked exactly like one that worked.
		shuffled: [
			['delta', 12],
			['charlie', 4],
			['alpha', 9],
			['bravo', 2]
		]
	};

	function valuesSql(rows) {
		return rows.flatMap(([cat, n]) => Array.from({ length: n }, () => `('${cat}')`)).join(', ');
	}

	async function build(key) {
		const rows = DATASETS[key];
		await queryEngine.exec(
			`CREATE OR REPLACE TABLE reload_cats AS SELECT * FROM (VALUES ${valuesSql(rows)}) AS t(cat)`
		);
		// Sorted, because that is the expectation being asserted: display order
		// comes from the dim (ORDER BY value), never from the order the rows were
		// inserted in. Printing the rows in table order instead would have made
		// the shuffled reload look like a reorder that failed.
		expected = [...rows]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([c, n]) => `${c}=${n}`)
			.join('   ');
	}

	async function reload(key, label) {
		if (busy) return;
		busy = true;
		status = `reloading (${label})…`;
		try {
			// The order an embedder uses: replace the data, THEN invalidate. The
			// await matters — clearQueryCache resolves only once the listeners
			// have run, so the marks have been told to re-run setup by the time
			// this returns.
			await build(key);
			await queryEngine.clearQueryCache();
			status = `loaded: ${label}`;
		} catch (e) {
			error = String(e);
			status = 'failed';
		} finally {
			busy = false;
		}
	}

	onMount(async () => {
		try {
			await build('initial');
			isLoaded = true;
			status = 'loaded: initial';
		} catch (e) {
			error = String(e);
		}
	});
</script>

<div class="page">
	<h1>Identity reload — §20.1 verification</h1>
	<p class="note">
		The only route that exercises <code>clearQueryCache()</code>, which drops every identity dim and
		view out from under the marks' query parts. Reload, then check the labels sit on their own bars
		and the tooltips agree. Press each button twice: the listener has to survive its own re-setup.
	</p>

	{#if error}
		<pre class="error">{error}</pre>
	{:else if !isLoaded}
		<p class="note">Loading…</p>
	{:else}
		<div class="controls">
			<button onclick={() => reload('same', 'same categories')} disabled={busy}>
				Reload (same categories)
			</button>
			<button onclick={() => reload('renumbered', 'renumbered')} disabled={busy}>
				Reload (renumbered — drops charlie, adds echo)
			</button>
			<button onclick={() => reload('shuffled', 'shuffled rows, new counts')} disabled={busy}>
				Reload (shuffled rows, new counts — order must NOT move)
			</button>
			<span class="status">{status}</span>
		</div>

		<p class="note">
			Expected, left to right: <code>{expected}</code><br />
			Order is always alphabetical — the dim numbers values with
			<code>ORDER BY value</code> and an unsorted band axis reads them in id order, so row order in the
			table never moves a bar. Heights are what change.
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
							<BarMarkY table="reload_cats" x="cat" y={count()} tip={['x', 'y']} />
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
			</ChartContainer>
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

	.note {
		color: #666;
		font-size: 13px;
		max-width: 80ch;
	}

	.controls {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		margin: 12px 0;
	}

	button {
		font: inherit;
		font-size: 13px;
		padding: 5px 10px;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.status {
		color: #666;
		font-size: 12px;
	}

	.chart {
		width: 560px;
		height: 340px;
	}

	.error {
		color: #b00;
		font-size: 12px;
		white-space: pre-wrap;
	}
</style>
