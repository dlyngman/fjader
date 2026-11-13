<script lang="ts">
	/**
	 * Phase 0 (proposal_query_scheduling.md): what DuckDB-WASM itself allows,
	 * on its own instance with two connections, A and B, outside fjader.
	 *
	 * 1. Round trip: 200 tiny queries sent at once against one at a time; the
	 *    difference is what a scheduler capped at one in flight would add.
	 * 2. Blocking: a slow query via runQuery on B, a small one on A 50 ms later.
	 * 3. Slicing: the same slow query via the pending-query API on B (raw IPC,
	 *    polled), the small one on A: does it return before the slow one ends?
	 * 4. Cancel: the slow pending query cancelled at 200 ms; when is the worker
	 *    free again, and does A's small query return early?
	 */
	import * as duckdb from '@duckdb/duckdb-wasm';
	import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
	import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
	import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
	import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
	import { onMount } from 'svelte';
	import { tableFromIPC } from '@uwdata/flechette';
	import { connectionFrom } from '$lib/query-engine';
	import type { SlicedLane } from '$lib/query-engine';

	type Conn = duckdb.AsyncDuckDBConnection;
	let a: Conn;
	let b: Conn;
	let ready = $state(false);
	let running = $state(false);
	let pollInterval = $state('default');
	let rows = $state<{ test: string; result: string }[]>([]);

	const SLOW = 'SELECT sum(hash(i) % 7) FROM range(60000000) t(i)';
	const SMALL = 'SELECT 42 AS answer';

	async function open() {
		ready = false;
		const bundle = await duckdb.selectBundle({
			mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
			eh: { mainModule: ehWasm, mainWorker: ehWorker }
		});
		const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker!));
		await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
		if (pollInterval !== 'default') {
			await db.open({ query: { queryPollingInterval: Number(pollInterval) } });
		}
		a = await db.connect();
		b = await db.connect();
		lane = null;
		ready = true;
	}

	const now = () => performance.now();
	const fmt = (ms: number) => `${ms.toFixed(1)} ms`;
	function add(test: string, result: string) {
		rows = [...rows, { test: `[poll ${pollInterval}] ${test}`, result }];
	}

	const runQuery = (c: Conn, sql: string) =>
		c.useUnsafe((bd, id) => bd.runQuery(id, sql)) as Promise<Uint8Array>;

	/** The pending-query API on raw IPC: start, poll until the header, fetch chunks. */
	async function runSliced(c: Conn, sql: string): Promise<{ polls: number; bytes: number }> {
		return c.useUnsafe(async (bd, id) => {
			let polls = 0;
			let header = await bd.startPendingQuery(id, sql, false);
			while (header == null) {
				polls++;
				header = await bd.pollPendingQuery(id);
			}
			let bytes = header.byteLength;
			for (;;) {
				const chunk = await bd.fetchQueryResults(id);
				if (!chunk || chunk.byteLength === 0) break;
				bytes += chunk.byteLength;
			}
			return { polls, bytes };
		}) as Promise<{ polls: number; bytes: number }>;
	}

	async function exp(fn: () => Promise<void>) {
		running = true;
		try {
			await fn();
		} catch (e) {
			add('error', String(e));
		}
		running = false;
	}

	const roundTrip = () =>
		exp(async () => {
			const n = 200;
			let t = now();
			await Promise.all(Array.from({ length: n }, () => runQuery(a, SMALL)));
			const together = now() - t;
			t = now();
			for (let i = 0; i < n; i++) await runQuery(a, SMALL);
			const oneByOne = now() - t;
			add(
				'1 round trip',
				`${n} tiny queries: all at once ${fmt(together)}, one at a time ${fmt(oneByOne)} ` +
					`→ ${((oneByOne - together) / n).toFixed(3)} ms more per statement at cap 1`
			);
		});

	const slowAlone = () =>
		exp(async () => {
			let t = now();
			await runQuery(b, SLOW);
			const viaRun = now() - t;
			t = now();
			const s = await runSliced(b, SLOW);
			add(
				'0 slow query alone',
				`runQuery ${fmt(viaRun)}; pending API ${fmt(now() - t)} (${s.polls} polls)`
			);
		});

	const blocking = () =>
		exp(async () => {
			const t0 = now();
			const slow = runQuery(b, SLOW).then(() => now() - t0);
			await new Promise((r) => setTimeout(r, 50));
			const ts = now();
			await runQuery(a, SMALL);
			const small = now() - ts;
			add(
				'2 blocking (runQuery)',
				`small query on A took ${fmt(small)}; slow on B ended at ${fmt(await slow)}`
			);
		});

	const slicing = () =>
		exp(async () => {
			const t0 = now();
			const slow = runSliced(b, SLOW).then((s) => ({ t: now() - t0, ...s }));
			await new Promise((r) => setTimeout(r, 50));
			const ts = now();
			await runQuery(a, SMALL);
			const small = now() - ts;
			const s = await slow;
			add(
				'3 slicing (pending API)',
				`small query on A took ${fmt(small)} (returned at ${fmt(ts - t0 + small)}); ` +
					`slow on B ended at ${fmt(s.t)} after ${s.polls} polls`
			);
		});

	const cancel = () =>
		exp(async () => {
			const t0 = now();
			let outcome = '';
			const slow = runSliced(b, SLOW).then(
				() => {
					outcome = 'completed';
					return now() - t0;
				},
				(e) => {
					outcome = `rejected: ${String(e).slice(0, 80)}`;
					return now() - t0;
				}
			);
			await new Promise((r) => setTimeout(r, 200));
			const tc = now();
			const cancelled = await b.useUnsafe((bd, id) => bd.cancelPendingQuery(id));
			const cancelAck = now() - tc;
			const ts = now();
			await runQuery(a, SMALL);
			const smallAt = now() - t0;
			const small = now() - ts;
			const slowEnd = await slow;
			const tAfter = now();
			await runQuery(b, SMALL);
			add(
				'4 cancel at 200 ms',
				`cancelPendingQuery → ${cancelled} after ${fmt(cancelAck)}; slow on B ${outcome} at ${fmt(slowEnd)}; ` +
					`small on A took ${fmt(small)} (at ${fmt(smallAt)}); B usable again: small on B ${fmt(now() - tAfter)}`
			);
		});

	/** Settle a promise into an outcome and the time it settled, without throwing. */
	function outcome(p: Promise<unknown>, t0: number): Promise<string> {
		return p.then(
			() => `completed at ${fmt(now() - t0)}`,
			(e) => `rejected at ${fmt(now() - t0)}: ${String(e).slice(0, 70)}`
		);
	}

	// 5. Two pending queries on the SAME connection: does the second reset the first?
	const twoPending = () =>
		exp(async () => {
			const t0 = now();
			const first = outcome(runSliced(b, SLOW), t0);
			await new Promise((r) => setTimeout(r, 100));
			const second = outcome(runSliced(b, SMALL), t0);
			add('5 two pending on B', `first (slow): ${await first}; second (small): ${await second}`);
		});

	// 6. A runQuery on a connection with a pending query in progress.
	const pendingThenRun = () =>
		exp(async () => {
			const t0 = now();
			const first = outcome(runSliced(b, SLOW), t0);
			await new Promise((r) => setTimeout(r, 100));
			const second = outcome(runQuery(b, SMALL), t0);
			add(
				'6 pending then runQuery on B',
				`first (slow, pending): ${await first}; second (small, runQuery): ${await second}`
			);
		});

	// 7. A large result (200k rows × 2 floats, like a dots mark): runQuery against the
	//    pending API with chunked fetch, both returning raw IPC. Times the bytes only;
	//    also how many record batches each decodes into (a column split across
	//    batches is copied when read as one typed array).
	/** Burn ~8 ms of main thread every frame, as decoding and GPU uploads do while brushing. */
	function busyMainThread(): () => void {
		const id = setInterval(() => {
			const until = now() + 8;
			while (now() < until) {
				/* busy */
			}
		}, 16);
		return () => clearInterval(id);
	}

	async function largeResultRun(label: string, busy: boolean) {
		await runQuery(
			a,
			'CREATE OR REPLACE TABLE big AS SELECT random()::REAL AS x, random()::REAL AS y FROM range(200000)'
		);
		const sql = 'SELECT x, y FROM big';
		const times = { run: [] as number[], sliced: [] as number[] };
		let chunks = 0;
		let bytes = 0;
		let runBatches = 0;
		let slicedBatches = 0;
		const stop = busy ? busyMainThread() : () => {};
		try {
			for (let i = 0; i < 5; i++) {
				let t = now();
				const ipc = await runQuery(a, sql);
				times.run.push(now() - t);
				bytes = ipc.byteLength;
				t = now();
				const parts = (await b.useUnsafe(async (bd, id) => {
					let header = await bd.startPendingQuery(id, sql, false);
					while (header == null) header = await bd.pollPendingQuery(id);
					const out: Uint8Array[] = [header];
					for (;;) {
						const c = await bd.fetchQueryResults(id);
						if (!c || c.byteLength === 0) break;
						out.push(c);
					}
					return out;
				})) as Uint8Array[];
				times.sliced.push(now() - t);
				chunks = parts.length;
				if (i === 0) {
					runBatches = tableFromIPC(ipc).children[0].data.length;
					slicedBatches = tableFromIPC(parts).children[0].data.length;
				}
			}
		} finally {
			stop();
		}
		const med = (xs: number[]) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
		add(
			label,
			`runQuery median ${fmt(med(times.run))} (${(bytes / 1e6).toFixed(1)} MB IPC, ${runBatches} batches); ` +
				`pending + chunked fetch median ${fmt(med(times.sliced))} in ${chunks} chunks (${slicedBatches} batches)`
		);
	}

	const largeResult = () => exp(() => largeResultRun('7 large result (200k × 2)', false));
	const largeResultBusy = () =>
		exp(() => largeResultRun('7b large result, main thread busy 8 ms/frame', true));

	// 8. Scratch catalog: a view in an attached in-memory catalog reading a main
	//    table by an unqualified name; and a transaction writing both catalogs.
	const scratchCatalog = () =>
		exp(async () => {
			const run = (sql: string) => runQuery(a, sql);
			await run('CREATE OR REPLACE TABLE scratch_src AS SELECT range AS v FROM range(5)');
			await run("ATTACH IF NOT EXISTS ':memory:' AS fjader");
			let view: string;
			try {
				await run('CREATE OR REPLACE VIEW fjader.v AS SELECT count(*) AS n FROM scratch_src');
				await run('SELECT * FROM fjader.v');
				view = 'unqualified name in a fjader view resolves';
			} catch (e) {
				view = `unqualified view fails: ${String(e).slice(0, 90)}`;
			}
			let txn: string;
			try {
				await run(
					'BEGIN; CREATE OR REPLACE TABLE fjader.t AS SELECT 1 AS a; CREATE OR REPLACE TABLE main.t2 AS SELECT 1 AS a; COMMIT;'
				);
				txn = 'two-catalog transaction allowed';
			} catch (e) {
				txn = `two-catalog transaction refused: ${String(e).slice(0, 90)}`;
				await run('ROLLBACK').catch(() => {});
			}
			let other: string;
			try {
				await runQuery(b, 'SELECT * FROM fjader.v');
				other = 'view visible from connection B';
			} catch (e) {
				other = `view NOT visible from B: ${String(e).slice(0, 80)}`;
			}
			const version = await a.query('SELECT version() AS v');
			add('8 scratch catalog', `${version.get(0)?.v}: ${view}; ${other}; ${txn}`);
		});

	// 9. fjader's own lane (connectionFrom(a).openSlicedLane): the slow query
	//    sliced on the lane, a small one on the main connection 50 ms in; then
	//    the same with an abort at 200 ms; then the batches a lane result
	//    decodes into against runQuery's, for a 200k-row read.
	let lane: SlicedLane | null = null;
	const fjaderLane = () =>
		exp(async () => {
			const fj = connectionFrom(a, {
				pollingIntervalMs: pollInterval === 'default' ? undefined : Number(pollInterval)
			});
			lane ??= await fj.openSlicedLane!();
			let t0 = now();
			const slow = lane.query(SLOW).then((r) => ({ t: now() - t0, polls: r.polls }));
			await new Promise((r) => setTimeout(r, 50));
			let ts = now();
			await fj.queryIPC!(SMALL);
			const small = now() - ts;
			const s = await slow;
			add(
				'9a fjader lane',
				`small on the main connection took ${fmt(small)}; slow on the lane ended at ${fmt(s.t)} after ${s.polls} polls`
			);

			t0 = now();
			const ctl = new AbortController();
			const aborted = lane.query(SLOW, ctl.signal).then(
				() => `completed at ${fmt(now() - t0)}`,
				(e) => `${e?.name} at ${fmt(now() - t0)}`
			);
			await new Promise((r) => setTimeout(r, 200));
			ctl.abort();
			const result = await aborted;
			ts = now();
			await lane.exec(SMALL);
			add(
				'9b fjader lane, abort at 200 ms',
				`slow: ${result}; next statement on the lane took ${fmt(now() - ts)}`
			);

			await fj.exec!(
				'CREATE OR REPLACE TABLE big AS SELECT random()::REAL AS x, random()::REAL AS y FROM range(200000)'
			);
			const viaRun = tableFromIPC(await fj.queryIPC!('SELECT x, y FROM big'));
			const viaLane = tableFromIPC((await lane.query('SELECT x, y FROM big')).ipc);
			add(
				'9c batches, 200k rows',
				`runQuery ${viaRun.getChild('x')!.data.length} batches, lane ${viaLane.getChild('x')!.data.length} batches; ` +
					`rows ${viaRun.numRows} / ${viaLane.numRows}`
			);
		});

	// 10. How types come back, under the current polling setting: run it at
	//     "default" and at "5 ms" (the select reopens the database with only the
	//     polling interval in its query config) and compare.
	const types = () =>
		exp(async () => {
			const ipc = await runQuery(
				a,
				`SELECT count(*) AS n, sum(i)::BIGINT AS big, 12.345::DECIMAL(10, 3) AS dec,
				 TIMESTAMP '2024-03-01 12:34:56' AS ts, INTERVAL 90 MINUTE AS dur
				 FROM range(10) t(i)`
			);
			const t = tableFromIPC(ipc);
			const row = t.get(0) as Record<string, unknown>;
			const desc = t.schema.fields
				.map((f) => {
					const v = row[f.name];
					const shown = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
					return `${f.name}: type ${f.type.typeId} ${typeof v} ${shown}`;
				})
				.join('; ');
			add('10 types', desc);
		});

	onMount(open);
</script>

<div class="page">
	<p>
		Slow query: <code>{SLOW}</code>. Run 0 first for its duration.
		<label>
			polling interval
			<select bind:value={pollInterval} onchange={open} disabled={running}>
				<option value="default">default</option>
				<option value="5">5 ms</option>
				<option value="20">20 ms</option>
				<option value="100">100 ms</option>
			</select>
		</label>
	</p>
	<div class="buttons">
		<button disabled={!ready || running} onclick={slowAlone}>0 slow query alone</button>
		<button disabled={!ready || running} onclick={roundTrip}>1 round trip</button>
		<button disabled={!ready || running} onclick={blocking}>2 blocking</button>
		<button disabled={!ready || running} onclick={slicing}>3 slicing</button>
		<button disabled={!ready || running} onclick={cancel}>4 cancel</button>
		<button disabled={!ready || running} onclick={twoPending}>5 two pending on B</button>
		<button disabled={!ready || running} onclick={pendingThenRun}>6 pending + runQuery on B</button>
		<button disabled={!ready || running} onclick={largeResult}>7 large result</button>
		<button disabled={!ready || running} onclick={largeResultBusy}>7b large result, busy</button>
		<button disabled={!ready || running} onclick={scratchCatalog}>8 scratch catalog</button>
		<button disabled={!ready || running} onclick={fjaderLane}>9 fjader lane</button>
		<button disabled={!ready || running} onclick={types}>10 types</button>
	</div>
	<p>{ready ? (running ? 'running…' : 'ready') : 'starting DuckDB…'}</p>
	<table>
		<tbody>
			{#each rows as row, i (i)}
				<tr><td>{row.test}</td><td>{row.result}</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.page {
		padding: 1.5rem;
		font-family: system-ui, sans-serif;
	}
	.buttons {
		display: flex;
		gap: 0.5rem;
	}
	td {
		padding: 0.25rem 0.75rem;
		border-bottom: 1px solid #ddd;
		font-family: ui-monospace, monospace;
		font-size: 0.85rem;
		vertical-align: top;
	}
</style>
