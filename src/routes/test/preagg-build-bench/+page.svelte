<script>
	// Preagg builds in DuckDB-WASM: what they cost, and how they share one connection
	// with the queries a user is waiting on. Backs proposals/preagg_activation.md §6 and §9.
	//
	// WHY A ROUTE. A first pass ran duckdb-wasm in Node through a web-worker shim, 3–5
	// runs each, on hash()-generated data. Its numbers said the DuckDB 2.0 build is
	// 15–55% slower on our queries, and that a cancelled send() lands within one
	// polling step. Neither is trustworthy until measured in a browser worker, with
	// enough runs to see the spread, on data with real column shapes.
	//
	// THE QUESTIONS, and what the Node pass expects, written down first:
	//
	//   1. Workload. Same SQL on the installed 1.30.0 and on the next build (DuckDB 2.0
	//      core). Expect 2.0 no faster; base clicks and VARCHAR-grouped builds slower.
	//      Reading the view should cost ~1.5–2× the bare table; "raw then ids" should
	//      cost the same as "raw column".
	//   2. send() vs runQuery for a build. Expect ~1% overhead at any polling interval,
	//      and steps of about one interval each.
	//   3. Cancel. Expect cancelSent() to settle within one polling interval, no table to
	//      be created, and a probe query right after to run at idle speed (the work
	//      stopped, it was not merely abandoned).
	//   4. Hover then click. Six builds, then a click at a random moment. Expect "wait"
	//      to cost up to one build on top of the base click, and "cancel" to cost about
	//      one polling interval, at the price of redoing the cancelled build.
	//
	// Data: flights-200k's delay, distance and time, replicated with jitter, plus a
	// generated skewed carrier (20) and origin (300), since the parquet has no
	// categorical columns. Dims and the view follow categorical-identity.ts.

	import {
		ENGINES,
		SIZES,
		MARKS,
		startEngine,
		openEngine,
		stopEngine,
		runWorkload,
		runSendOverhead,
		runCancel,
		runHoverClick,
		stats
	} from './bench.js';

	const INTERVALS = [100, 20, 5];

	let selectedSizes = $state([200_000, 1_000_000]);
	let selectedEngines = $state(['installed', 'next']);
	let reps = $state(20);
	let runWork = $state(true);
	let runSched = $state(true);

	let running = $state(false);
	let status = $state('idle');
	let error = $state(null);
	let copied = $state(false);

	let setup = $state([]);
	let workload = $state([]);
	let overhead = $state([]);
	let cancels = $state([]);
	let hovers = $state([]);

	const fmt = (ms) => (ms == null ? '–' : ms < 10 ? ms.toFixed(1) : ms.toFixed(0));
	const spread = (s) => `${fmt(s.median)} (${fmt(s.p10)}–${fmt(s.p90)})`;
	const sizeLabel = (n) => (n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}k`);

	function toggle(list, value) {
		return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
	}

	async function runAll() {
		running = true;
		error = null;
		setup = [];
		workload = [];
		overhead = [];
		cancels = [];
		hovers = [];
		const sizes = SIZES.filter((s) => selectedSizes.includes(s));
		const keys = Object.keys(ENGINES).filter((k) => selectedEngines.includes(k));
		let engines = [];
		try {
			for (const rows of sizes) {
				status = `${sizeLabel(rows)}: starting engines…`;
				engines = [];
				for (const key of keys) {
					const engine = await startEngine(key);
					status = `${sizeLabel(rows)}: loading ${engine.label}…`;
					const loadMs = await openEngine(engine, { rows, pollingInterval: INTERVALS[0] });
					engines.push(engine);
					setup = [
						...setup,
						{ rows, engine: engine.label, bundle: engine.bundle, version: engine.version, loadMs }
					];
				}

				if (runWork) {
					const out = await runWorkload(
						engines,
						reps,
						(s) => (status = `${sizeLabel(rows)} workload — ${s}`)
					);
					workload = [...workload, ...out.map((r) => ({ rows, ...r }))];
				}

				if (runSched) {
					for (const engine of engines) {
						for (const interval of INTERVALS) {
							const tag = `${sizeLabel(rows)} ${engine.label} @${interval} ms`;
							if (engine.pollingInterval !== interval) {
								status = `${tag}: reloading…`;
								await openEngine(engine, { rows, pollingInterval: interval });
							}

							status = `${tag}: send() vs runQuery…`;
							const o = await runSendOverhead(engine, Math.max(5, Math.round(reps / 2)));
							overhead = [...overhead, { rows, engine: engine.key, interval, ...o }];

							status = `${tag}: cancel…`;
							const c = await runCancel(engine, reps, o.run.median);
							cancels = [...cancels, { rows, engine: engine.key, interval, ...c }];

							// Click moments spread over the whole build phase, the same ones for every policy.
							const runs = Math.max(5, Math.round(reps / 2));
							const span = o.run.median * MARKS.length;
							const clickTimes = Array.from({ length: runs }, () => Math.random() * span);
							const policies = interval === INTERVALS[0] ? ['none', 'wait', 'cancel'] : ['cancel'];
							for (const policy of policies) {
								const results = [];
								for (let i = 0; i < runs; i++) {
									status = `${tag}: hover + click, ${policy} ${i + 1}/${runs}…`;
									results.push(await runHoverClick(engine, policy, clickTimes[i]));
								}
								hovers = [
									...hovers,
									{
										rows,
										engine: engine.key,
										policy: policy === 'cancel' ? `cancel @${interval} ms` : policy,
										click: stats(results.map((r) => r.click)),
										builds: policy === 'none' ? null : stats(results.map((r) => r.buildsDone)),
										cancelled: results.reduce((a, r) => a + r.cancelledBuilds, 0) / runs
									}
								];
							}
						}
					}
				}

				for (const e of engines) await stopEngine(e);
				engines = [];
			}
			status = 'done';
		} catch (e) {
			error = String(e?.stack ?? e);
			status = 'failed';
		} finally {
			for (const e of engines) await stopEngine(e).catch(() => {});
			running = false;
		}
	}

	/** Workload rows pivoted to one line per (size, query), one column per engine. */
	const workloadRows = $derived.by(() => {
		const byKey = new Map();
		for (const r of workload) {
			const k = `${r.rows}|${r.query}`;
			if (!byKey.has(k)) byKey.set(k, { rows: r.rows, query: r.query });
			byKey.get(k)[r.engine] = r;
		}
		return [...byKey.values()];
	});

	function markdown() {
		const lines = [];
		const table = (head, rows) => {
			lines.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
			for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
			lines.push('');
		};
		lines.push(
			`Preagg build bench, ${new Date().toISOString().slice(0, 10)}, ${navigator.userAgent}`,
			''
		);
		lines.push(`Median (p10–p90) in ms, ${reps} reps.`, '');
		table(
			['Rows', 'Engine', 'Bundle', 'Core', 'Load ms'],
			setup.map((s) => [sizeLabel(s.rows), s.engine, s.bundle, s.version, fmt(s.loadMs)])
		);
		if (workloadRows.length) {
			table(
				['Rows', 'Query', 'installed', 'next', 'next / installed'],
				workloadRows.map((r) => [
					sizeLabel(r.rows),
					r.query,
					r.installed ? spread(r.installed) : '–',
					r.next ? spread(r.next) : '–',
					r.installed && r.next ? `${(r.next.median / r.installed.median).toFixed(2)}×` : '–'
				])
			);
		}
		if (overhead.length) {
			table(
				['Rows', 'Engine', 'Interval', 'runQuery', 'send()', 'Steps'],
				overhead.map((o) => [
					sizeLabel(o.rows),
					o.engine,
					o.interval,
					spread(o.run),
					spread(o.send),
					o.polls
				])
			);
		}
		if (cancels.length) {
			table(
				[
					'Rows',
					'Engine',
					'Interval',
					'Cancel settles',
					'Probe after',
					'Probe idle',
					'Tables left',
					'Not cancelled'
				],
				cancels.map((c) => [
					sizeLabel(c.rows),
					c.engine,
					c.interval,
					spread(c.settle),
					spread(c.probeAfter),
					spread(c.probeAlone),
					c.created,
					c.notCancelled
				])
			);
		}
		if (hovers.length) {
			table(
				['Rows', 'Engine', 'Policy', 'Click latency', 'All builds done', 'Builds redone per run'],
				hovers.map((h) => [
					sizeLabel(h.rows),
					h.engine,
					h.policy,
					spread(h.click),
					h.builds ? spread(h.builds) : '–',
					h.cancelled.toFixed(1)
				])
			);
		}
		return lines.join('\n');
	}

	async function copyMarkdown() {
		await navigator.clipboard.writeText(markdown());
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="page">
	<h1>Preagg builds in DuckDB-WASM</h1>
	<p class="lede">
		What a preagg build costs on each engine, and what a click pays when it lands during the builds
		a legend hover started. One connection throughout, as in the app. Keep the tab in the foreground
		while it runs; a background tab throttles timers.
	</p>

	<fieldset disabled={running}>
		<div class="row">
			<span class="label">Rows</span>
			{#each SIZES as size (size)}
				<label>
					<input
						type="checkbox"
						checked={selectedSizes.includes(size)}
						onchange={() => (selectedSizes = toggle(selectedSizes, size))}
					/>
					{sizeLabel(size)}
				</label>
			{/each}
		</div>
		<div class="row">
			<span class="label">Engines</span>
			{#each Object.entries(ENGINES) as [key, engine] (key)}
				<label>
					<input
						type="checkbox"
						checked={selectedEngines.includes(key)}
						onchange={() => (selectedEngines = toggle(selectedEngines, key))}
					/>
					{engine.label}
				</label>
			{/each}
		</div>
		<div class="row">
			<span class="label">Runs</span>
			<label>reps <input type="number" min="3" max="100" bind:value={reps} /></label>
			<label><input type="checkbox" bind:checked={runWork} /> workload</label>
			<label
				><input type="checkbox" bind:checked={runSched} /> scheduling (intervals {INTERVALS.join(
					', '
				)} ms)</label
			>
		</div>
		<div class="row">
			<button onclick={runAll}>Run</button>
			<button onclick={copyMarkdown} disabled={!setup.length}
				>{copied ? 'Copied' : 'Copy as markdown'}</button
			>
		</div>
	</fieldset>

	<p class="status"><strong>{status}</strong></p>
	{#if error}
		<pre class="error">{error}</pre>
	{/if}

	{#if setup.length}
		<h2>Engines</h2>
		<table>
			<thead
				><tr><th>rows</th><th>engine</th><th>bundle</th><th>core</th><th>load ms</th></tr></thead
			>
			<tbody>
				{#each setup as s, i (i)}
					<tr
						><td>{sizeLabel(s.rows)}</td><td>{s.engine}</td><td>{s.bundle}</td><td>{s.version}</td
						><td>{fmt(s.loadMs)}</td></tr
					>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if workloadRows.length}
		<h2>1. Workload — median (p10–p90) ms</h2>
		<table>
			<thead
				><tr><th>rows</th><th>query</th><th>installed</th><th>next</th><th>next / installed</th></tr
				></thead
			>
			<tbody>
				{#each workloadRows as r (`${r.rows}|${r.query}`)}
					{@const ratio = r.installed && r.next ? r.next.median / r.installed.median : null}
					<tr>
						<td>{sizeLabel(r.rows)}</td>
						<td>{r.query}</td>
						<td>{r.installed ? spread(r.installed) : '–'}</td>
						<td>{r.next ? spread(r.next) : '–'}</td>
						<td class:bad={ratio > 1.15} class:good={ratio != null && ratio < 0.87}>
							{ratio ? `${ratio.toFixed(2)}×` : '–'}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if overhead.length}
		<h2>2. Build: runQuery vs send()</h2>
		<table>
			<thead
				><tr
					><th>rows</th><th>engine</th><th>interval</th><th>runQuery</th><th>send()</th><th
						>steps</th
					></tr
				></thead
			>
			<tbody>
				{#each overhead as o, i (i)}
					<tr>
						<td>{sizeLabel(o.rows)}</td><td>{o.engine}</td><td>{o.interval} ms</td>
						<td>{spread(o.run)}</td><td>{spread(o.send)}</td><td>{o.polls}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if cancels.length}
		<h2>3. Cancel a send() build at a random point</h2>
		<p class="lede">
			"Probe after" near "probe idle" means the build stopped rather than kept running in the
			worker. "Tables left" should be 0.
		</p>
		<table>
			<thead>
				<tr
					><th>rows</th><th>engine</th><th>interval</th><th>cancel settles</th><th>probe after</th
					><th>probe idle</th><th>tables left</th><th>not cancelled</th></tr
				>
			</thead>
			<tbody>
				{#each cancels as c, i (i)}
					<tr>
						<td>{sizeLabel(c.rows)}</td><td>{c.engine}</td><td>{c.interval} ms</td>
						<td>{spread(c.settle)}</td><td>{spread(c.probeAfter)}</td><td>{spread(c.probeAlone)}</td
						>
						<td class:bad={c.created > 0}>{c.created}</td><td>{c.notCancelled}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if hovers.length}
		<h2>4. Legend hover builds 6 tables, click lands at a random moment</h2>
		<table>
			<thead>
				<tr
					><th>rows</th><th>engine</th><th>policy</th><th>click latency</th><th>all builds done</th
					><th>builds redone / run</th></tr
				>
			</thead>
			<tbody>
				{#each hovers as h, i (i)}
					<tr>
						<td>{sizeLabel(h.rows)}</td><td>{h.engine}</td><td>{h.policy}</td>
						<td>{spread(h.click)}</td><td>{h.builds ? spread(h.builds) : '–'}</td><td
							>{h.cancelled.toFixed(1)}</td
						>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.page {
		max-width: 1100px;
		margin: 0 auto;
		padding: 24px 16px;
		font-family: system-ui, sans-serif;
	}
	.lede {
		color: #555;
		max-width: 75ch;
	}
	fieldset {
		border: 1px solid #ddd;
		border-radius: 6px;
		padding: 12px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
		margin: 6px 0;
	}
	.label {
		font-weight: 600;
		min-width: 64px;
	}
	input[type='number'] {
		width: 4em;
	}
	table {
		border-collapse: collapse;
		margin: 8px 0 24px;
		font-variant-numeric: tabular-nums;
	}
	th,
	td {
		border-bottom: 1px solid #eee;
		padding: 4px 10px;
		text-align: left;
	}
	.bad {
		color: #b00020;
		font-weight: 600;
	}
	.good {
		color: #1b7f3b;
		font-weight: 600;
	}
	.error {
		color: #b00020;
		white-space: pre-wrap;
	}
	.status {
		margin: 12px 0;
	}
</style>
