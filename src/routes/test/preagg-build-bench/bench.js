// Measurement harness for preagg builds in DuckDB-WASM. See +page.svelte for the questions.
//
// Everything here talks to duckdb-wasm directly rather than through QueryEngine: the
// questions are about the engine (send() vs runQuery, cancellation, polling interval,
// core version), and QueryEngine's wrapper exposes none of that. Queries go through
// `runQuery`, the same call `initDuckDB()` uses for `queryIPC`, so the timings include
// the IPC encode but not the flechette decode the app adds.

import * as installed from '@duckdb/duckdb-wasm';
import { tableFromIPC, tableToIPC } from '@uwdata/flechette';

export const NEXT_VERSION = '1.33.1-dev110.0';

export const ENGINES = {
	installed: {
		label: 'installed (1.30.0)',
		load: async () => installed
	},
	next: {
		label: `next (${NEXT_VERSION}, DuckDB 2.0 core)`,
		// Loaded from jsDelivr so package.json does not change for a measurement.
		load: () =>
			import(
				/* @vite-ignore */ `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${NEXT_VERSION}/+esm`
			)
	}
};

export const SIZES = [200_000, 1_000_000, 3_000_000, 10_000_000];

const CARRIERS = ['AA', 'DL', 'UA', 'WN', 'B6', 'AS', 'NK', 'F9', 'G4', 'HA'].concat([
	'MQ',
	'OO',
	'YX',
	'9E',
	'OH',
	'YV',
	'QX',
	'ZW',
	'C5',
	'G7'
]);
/** The legend toggle every click applies: 2 of 20 carriers, one common and one rare. */
export const TOGGLED = ['UA', 'G7'];

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

export async function startEngine(key) {
	const duckdb = await ENGINES[key].load();
	const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
	const workerUrl = URL.createObjectURL(
		new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
	);
	const worker = new Worker(workerUrl);
	const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
	await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
	URL.revokeObjectURL(workerUrl);
	return {
		key,
		label: ENGINES[key].label,
		bundle: bundle.mainModule.split('/').pop(),
		db,
		worker,
		conn: null,
		version: null,
		pollingInterval: null
	};
}

/**
 * (Re)open the database with a polling interval, and seed it. The interval is a
 * database-open setting, so changing it means a fresh database and a reload.
 */
export async function openEngine(engine, { rows, pollingInterval }) {
	if (engine.conn) await engine.conn.close();
	await engine.db.open({ path: ':memory:', query: { queryPollingInterval: pollingInterval } });
	engine.conn = await engine.db.connect();
	engine.pollingInterval = pollingInterval;
	engine.version = (await rowsOf(engine, `SELECT version() AS v`))[0].v;
	const t = performance.now();
	await seed(engine, rows);
	return performance.now() - t;
}

export async function stopEngine(engine) {
	try {
		if (engine.conn) await engine.conn.close();
		await engine.db.terminate();
	} finally {
		engine.worker.terminate();
	}
}

/** QueryEngine's path: one blocking call in the worker, Arrow IPC bytes back. */
export function run(engine, sql) {
	return engine.conn.useUnsafe((b, id) => b.runQuery(id, sql));
}

/** The pending-query path: the worker runs the statement in steps and can be cancelled between them. */
export async function send(engine, sql) {
	const reader = await engine.conn.send(sql);
	for await (const _batch of reader); // a CREATE returns an empty result; drain it anyway
}

async function rowsOf(engine, sql) {
	return (await engine.conn.query(sql)).toArray().map((r) => r.toJSON());
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

let baseStreamPromise = null;

/**
 * flights-200k plus a row id, as Arrow IPC stream bytes, read once per page load.
 *
 * Read by a short-lived installed engine and handed to every engine as Arrow,
 * because the next build cannot read parquet: it autoloads the parquet extension
 * for its unreleased version, which extensions.duckdb.org does not serve. runQuery
 * returns the IPC *file* format and insertArrowFromIPCStream silently inserts
 * nothing from it, hence the flechette round trip to the stream format.
 */
function baseStream() {
	baseStreamPromise ??= (async () => {
		const helper = await startEngine('installed');
		try {
			await helper.db.open({ path: ':memory:' });
			helper.conn = await helper.db.connect();
			const url = `${window.location.origin}/data/flights-200k.parquet`;
			const file = await run(
				helper,
				`SELECT *, row_number() OVER () AS rid FROM read_parquet('${url}')`
			);
			return tableToIPC(tableFromIPC(file), { format: 'stream' });
		} finally {
			await stopEngine(helper);
		}
	})();
	baseStreamPromise.catch(() => (baseStreamPromise = null));
	return baseStreamPromise;
}

/**
 * flights-200k's real numeric columns, replicated with jitter to `rows`, plus two
 * generated categorical columns (the parquet has none): a skewed carrier (20) and
 * origin (300). Dims and the view are built the way categorical-identity.ts builds
 * them, so a view read costs what it costs in the app.
 */
async function seed(engine, rows) {
	// A copy: the insert may transfer the buffer to the worker.
	await engine.conn.insertArrowFromIPCStream((await baseStream()).slice(), {
		name: 'base',
		create: true
	});
	const baseRows = Number((await rowsOf(engine, `SELECT count(*)::INT AS n FROM base`))[0].n);
	const reps = Math.ceil(rows / baseRows);
	const carriers = `['${CARRIERS.join("', '")}']`;
	await run(
		engine,
		`CREATE TABLE flights AS
		 SELECT (delay + (rep % 11) - 5)::SMALLINT AS delay,
		        (distance + (rep % 13) * 3)::SMALLINT AS distance,
		        "time",
		        ${carriers}[1 + floor(20 * pow((hash(rid, rep, 1) % 1000000) / 1e6, 2))::INT] AS carrier,
		        'A' || lpad(floor(300 * pow((hash(rid, rep, 2) % 1000000) / 1e6, 1.5))::VARCHAR, 3, '0') AS origin
		 FROM base, range(${reps}) r(rep)
		 LIMIT ${rows}`
	);
	await run(engine, `DROP TABLE base`);

	for (const field of ['carrier', 'origin']) {
		await run(
			engine,
			`CREATE TABLE "__dplot_dim_${field}" AS
			 SELECT v AS value, NULL::VARCHAR AS label, (row_number() OVER (ORDER BY v) - 1)::INT AS id
			 FROM (SELECT DISTINCT "${field}" AS v FROM flights WHERE "${field}" IS NOT NULL)`
		);
	}
	await run(
		engine,
		`CREATE VIEW flights_v AS
		 SELECT t.* EXCLUDE ("__dplot_key_0", "__dplot_key_1"),
		        COALESCE(d0.id, -1) AS "__dplot_carrier_idx", COALESCE(d1.id, -1) AS "__dplot_origin_idx"
		 FROM (SELECT *, ("carrier") AS "__dplot_key_0", ("origin") AS "__dplot_key_1" FROM flights) t
		 LEFT JOIN "__dplot_dim_carrier" d0 ON t."__dplot_key_0" = d0.value
		 LEFT JOIN "__dplot_dim_origin" d1 ON t."__dplot_key_1" = d1.value`
	);
	const ids = await rowsOf(engine, `SELECT value, id FROM "__dplot_dim_carrier"`);
	engine.toggledIds = TOGGLED.map((v) => ids.find((r) => r.value === v).id);
}

// ---------------------------------------------------------------------------
// Marks: a dashboard filtered by a carrier legend
// ---------------------------------------------------------------------------

const real = (e) => `COALESCE(CAST(${e} AS REAL), 'NaN'::REAL)`;

/**
 * `source` is what the mark reads today: the view if it requested identity, the
 * bare table otherwise. `idDim` names the channel already carrying the carrier id.
 */
export const MARKS = [
	{
		id: 'carrier_bars',
		source: 'flights_v',
		idDim: 'color',
		dims: { x: '__dplot_carrier_idx', color: '__dplot_carrier_idx' },
		partials: { __ps0: 'count(*)' }
	},
	{
		id: 'origin_bars',
		source: 'flights_v',
		dims: { x: '__dplot_origin_idx' },
		partials: { __ps0: 'count(*)' }
	},
	{
		id: 'delay_hist',
		source: 'flights',
		dims: { x: 'floor(delay / 5) * 5' },
		partials: { __ps0: 'count(*)' }
	},
	{
		id: 'distance_hist',
		source: 'flights',
		dims: { x: 'floor(distance / 50) * 50' },
		partials: { __ps0: 'count(*)' }
	},
	{
		id: 'hour_count',
		source: 'flights',
		dims: { x: 'floor("time")' },
		partials: { __ps0: 'count(*)' }
	},
	{
		id: 'hour_mean_delay',
		source: 'flights',
		dims: { x: 'floor("time")' },
		partials: { __ps0: 'sum(delay)', __ps1: 'count(delay)' }
	}
];

const sel = (o) =>
	Object.entries(o)
		.map(([k, v]) => `${v} AS "${k}"`)
		.join(', ');
const keys = (o) =>
	Object.keys(o)
		.map((k) => `"${k}"`)
		.join(', ');
const toggledValues = () => TOGGLED.map((v) => `'${v}'`).join(', ');
const yOf = (m) => (m.partials.__ps1 ? 'SUM(__ps0) / SUM(__ps1)' : 'SUM(__ps0)');

/** The mark's query on the base table, with the legend clause applied. */
export function baseQuery(m) {
	const dims = Object.fromEntries(Object.entries(m.dims).map(([k, v]) => [k, real(v)]));
	const y = m.partials.__ps1 ? 'avg(delay)' : 'count(*)';
	return `SELECT ${sel(dims)}, ${real(y)} AS "y" FROM ${m.source}
		WHERE carrier IN (${toggledValues()}) GROUP BY ${keys(dims)}`;
}

/**
 * The preagg table's SELECT. `mode` is how the legend's value dim is added:
 * none (case 1 adds nothing), raw (group by the VARCHAR), rawThenIds (group by the
 * value, then map the small result to ids), view (read the view's id column).
 */
export function preaggSelect(m, mode) {
	const dims = Object.fromEntries(Object.entries(m.dims).map(([k, v]) => [k, real(v)]));
	if (mode === 'raw') dims.__active0 = 'carrier';
	if (mode === 'view') dims.__active0 = '__dplot_carrier_idx';
	const source = mode === 'view' ? 'flights_v' : m.source;
	if (mode === 'rawThenIds') {
		const inner = { ...dims, __raw: 'carrier' };
		const keep = [...Object.keys(dims), ...Object.keys(m.partials)]
			.map((c) => `p."${c}"`)
			.join(', ');
		return `SELECT ${keep}, COALESCE(d.id, -1) AS __active0
			FROM (SELECT ${sel({ ...inner, ...m.partials })} FROM ${source} GROUP BY ${keys(inner)}) p
			LEFT JOIN "__dplot_dim_carrier" d ON p.__raw = d.value`;
	}
	return `SELECT ${sel({ ...dims, ...m.partials })} FROM ${source} GROUP BY ${keys(dims)}`;
}

/** The click on a preagg table built with `mode`. */
export function preaggQuery(engine, m, table, mode) {
	const ids = engine.toggledIds.join(', ');
	const filter =
		mode === 'none'
			? `"${m.idDim}" IN (${ids})`
			: mode === 'raw'
				? `__active0 IN (${toggledValues()})`
				: `__active0 IN (${ids})`;
	return `SELECT ${keys(m.dims)}, ${real(yOf(m))} AS "y" FROM "${table}"
		WHERE ${filter} GROUP BY ${keys(m.dims)}`;
}

/** How a mark's legend table is built in the scheduling runs: the §2.1 resolution. */
export const scheduledMode = (m) => (m.idDim ? 'none' : 'rawThenIds');

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function stats(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
	return { n: s.length, p10: at(0.1), median: at(0.5), p90: at(0.9) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const fresh = (prefix) => `${prefix}_${seq++}`;

// ---------------------------------------------------------------------------
// 1. Workload: the same SQL on every engine, alternating engines per rep
// ---------------------------------------------------------------------------

/** One representative mark per query shape, so the table stays readable. */
export function workloadQueries(engine) {
	const hist = MARKS.find((m) => m.id === 'delay_hist');
	const origin = MARKS.find((m) => m.id === 'origin_bars');
	const carrier = MARKS.find((m) => m.id === 'carrier_bars');
	return [
		{ label: 'click, base table (delay histogram)', sql: () => baseQuery(hist) },
		{ label: 'click, view (origin bars)', sql: () => baseQuery(origin) },
		{ label: 'click, view (carrier bars)', sql: () => baseQuery(carrier) },
		{
			label: 'build, no active dim',
			sql: () => `CREATE OR REPLACE TABLE w_none AS ${preaggSelect(hist, 'none')}`
		},
		{
			label: 'build, raw column',
			sql: () => `CREATE OR REPLACE TABLE w_raw AS ${preaggSelect(hist, 'raw')}`
		},
		{
			label: 'build, raw then ids',
			sql: () => `CREATE OR REPLACE TABLE w_ids AS ${preaggSelect(hist, 'rawThenIds')}`
		},
		{
			label: 'build, from view',
			sql: () => `CREATE OR REPLACE TABLE w_view AS ${preaggSelect(hist, 'view')}`
		},
		{ label: 'click, preagg table', sql: () => preaggQuery(engine, hist, 'w_ids', 'rawThenIds') }
	];
}

/**
 * Times every workload query `reps` times per engine after one warm-up, alternating
 * which engine goes first each rep so thermal drift and GC land on both.
 */
export async function runWorkload(engines, reps, onProgress) {
	const out = [];
	const shapes = workloadQueries(engines[0]).map((q) => q.label);
	for (let qi = 0; qi < shapes.length; qi++) {
		const times = new Map(engines.map((e) => [e.key, []]));
		for (const e of engines) await run(e, workloadQueries(e)[qi].sql());
		for (let r = 0; r < reps; r++) {
			const order = r % 2 ? [...engines].reverse() : engines;
			for (const e of order) {
				const sql = workloadQueries(e)[qi].sql();
				const t = performance.now();
				await run(e, sql);
				times.get(e.key).push(performance.now() - t);
			}
			onProgress?.(`${shapes[qi]}: rep ${r + 1}/${reps}`);
		}
		for (const e of engines)
			out.push({ query: shapes[qi], engine: e.key, ...stats(times.get(e.key)) });
	}
	return out;
}

// ---------------------------------------------------------------------------
// 2. Scheduling, on one engine at its current polling interval
// ---------------------------------------------------------------------------

const BUILD_MARK = MARKS.find((m) => m.id === 'delay_hist');
const buildSQL = () => `CREATE TABLE ${fresh('b')} AS ${preaggSelect(BUILD_MARK, 'raw')}`;
const PROBE = `SELECT count(*) FROM flights WHERE delay > 0`;

/** runQuery vs send() for the same build, and how many worker steps send() takes. */
export async function runSendOverhead(engine, reps) {
	const viaRun = [];
	const viaSend = [];
	await run(engine, buildSQL());
	await send(engine, buildSQL());
	for (let r = 0; r < reps; r++) {
		const pair = r % 2 ? ['send', 'run'] : ['run', 'send'];
		for (const how of pair) {
			const t = performance.now();
			await (how === 'run' ? run(engine, buildSQL()) : send(engine, buildSQL()));
			(how === 'run' ? viaRun : viaSend).push(performance.now() - t);
		}
	}
	const db = engine.db;
	const orig = db.pollPendingQuery;
	let polls = 0;
	db.pollPendingQuery = (...a) => (polls++, orig.apply(db, a));
	try {
		await send(engine, buildSQL());
	} finally {
		db.pollPendingQuery = orig;
	}
	await dropScratch(engine);
	return { run: stats(viaRun), send: stats(viaSend), polls };
}

/**
 * Cancel a send() build at a random point. Checks the work actually stopped: no
 * table, and a full-scan probe right after takes what it takes on an idle worker
 * (a build still running would make it wait).
 */
export async function runCancel(engine, reps, buildMs) {
	const probeAlone = [];
	for (let r = 0; r < 3; r++) {
		const t = performance.now();
		await run(engine, PROBE);
		probeAlone.push(performance.now() - t);
	}
	const settle = [];
	const probeAfter = [];
	let created = 0;
	let notCancelled = 0;
	for (let r = 0; r < reps; r++) {
		const name = fresh('c');
		const p = send(engine, `CREATE TABLE ${name} AS ${preaggSelect(BUILD_MARK, 'raw')}`).then(
			() => 'completed',
			() => 'cancelled'
		);
		await sleep(Math.random() * buildMs * 0.9);
		const t = performance.now();
		await engine.conn.cancelSent();
		const outcome = await p;
		settle.push(performance.now() - t);
		if (outcome === 'completed') notCancelled++;
		const tp = performance.now();
		await run(engine, PROBE);
		probeAfter.push(performance.now() - tp);
		const exists = await rowsOf(
			engine,
			`SELECT count(*)::INT AS n FROM duckdb_tables() WHERE table_name = '${name}'`
		);
		if (Number(exists[0].n) > 0 && outcome === 'cancelled') created++;
	}
	await dropScratch(engine);
	return {
		settle: stats(settle),
		probeAfter: stats(probeAfter),
		probeAlone: stats(probeAlone),
		created,
		notCancelled
	};
}

/**
 * A legend hover starts one build per mark; a click (one query per mark) lands at
 * `clickAt` ms. One connection, one statement at a time, as in the app.
 *
 *   none:   no preagg; the click runs six base queries.
 *   wait:   builds via runQuery, queries ahead of queued builds, so the click waits
 *           only for the build already running.
 *   cancel: builds via send(); the click cancels the running build, runs, and the
 *           cancelled build goes back to the front of the queue.
 *
 * Returns click latency (from the click, not from when the loop noticed it) and when
 * the last build finished.
 */
export async function runHoverClick(engine, policy, clickAt) {
	const tables = {};
	const prefix = fresh('h');
	const queue = policy === 'none' ? [] : MARKS.map((m) => ({ m, table: `${prefix}_${m.id}` }));
	const t0 = performance.now();
	let clickRequested = false;
	let clickAtAbs = 0;
	let building = null;
	const timer = setTimeout(() => {
		clickRequested = true;
		clickAtAbs = performance.now();
		if (policy === 'cancel' && building) engine.conn.cancelSent();
	}, clickAt);

	let click = null;
	let buildsDone = policy === 'none' ? 0 : null;
	let cancelledBuilds = 0;
	while (click == null || queue.length) {
		if (clickRequested && click == null) {
			for (const m of MARKS) {
				const table = tables[m.id];
				await run(engine, table ? preaggQuery(engine, m, table, scheduledMode(m)) : baseQuery(m));
			}
			click = performance.now() - clickAtAbs;
			continue;
		}
		const task = queue.shift();
		if (!task) {
			await sleep(1);
			continue;
		}
		const sql = `CREATE TABLE "${task.table}" AS ${preaggSelect(task.m, scheduledMode(task.m))}`;
		building = task;
		try {
			await (policy === 'cancel' ? send(engine, sql) : run(engine, sql));
			tables[task.m.id] = task.table;
		} catch (e) {
			if (!/cancel/i.test(String(e?.message ?? e))) throw e;
			cancelledBuilds++;
			queue.unshift(task);
		}
		building = null;
		if (!queue.length && buildsDone == null) buildsDone = performance.now() - t0;
	}
	clearTimeout(timer);
	await dropScratch(engine);
	return { click, buildsDone, cancelledBuilds };
}

/** Drops every scratch table the scheduling runs created. */
async function dropScratch(engine) {
	const names = await rowsOf(
		engine,
		`SELECT table_name AS t FROM duckdb_tables() WHERE regexp_matches(table_name, '^(b|c|h)_[0-9]+')`
	);
	for (const { t } of names) await run(engine, `DROP TABLE IF EXISTS "${t}"`);
}
