/**
 * Integration test: preagg tables for toggle and legend sources (`value` dims).
 * Runs QueryEngine end to end against native DuckDB, with categorical identity
 * built as the app builds it, and checks each mark's rows against the same
 * query on the base table.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import duckdb from 'duckdb';
import { column, count, gt, isBetween, sql } from '@uwdata/mosaic-sql';
import type { ExprNode } from '@uwdata/mosaic-sql';
import {
	QueryEngine,
	type DuckDBConnection,
	type QueryDescriptor,
	type QueryEngineOptions
} from './QueryEngine';
import { FilterGroup } from './FilterGroup.svelte';
import type { MarkHandle } from './MarkHandle.svelte';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { dense, filter, having, topN } from '$lib/transforms';
import { bin } from '$lib/sql/bin';
import type { BinPadding, MarkConfig, Transform } from '$lib/types';
import {
	buildQueryParts,
	castReal,
	type NullDrop
} from '$lib/components/marks/lifecycle/query-builder';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
//
// t: 1000 rows. cat alternates 'a'/'b'; kind cycles 'p'/'q'/'r' with NULL every
// 7th row; g = i // 250; x = i (1000 distinct values, for the size guard).
// big: 100,000 rows with the same columns, for the relative cap.

const SEED_SQL = `
CREATE TABLE t AS
SELECT i AS x,
       CASE WHEN i % 2 = 0 THEN 'a' ELSE 'b' END AS cat,
       CASE WHEN i % 7 = 0 THEN NULL WHEN i % 3 = 0 THEN 'p' WHEN i % 3 = 1 THEN 'q' ELSE 'r' END AS kind,
       i // 250 AS g
FROM range(1000) r(i);
CREATE TABLE big AS
SELECT i % 1000 AS x, CASE WHEN i % 2 = 0 THEN 'a' ELSE 'b' END AS cat, (i % 1000) // 250 AS g
FROM range(100000) r(i)
`;

interface TestConn extends DuckDBConnection {
	queries: string[];
	/** While set, a preagg build waits on it after it is logged: holds a build running. */
	gate: Promise<void> | null;
	/** While set, a query waits on it after it is logged: holds mark queries in flight. */
	queryGate: Promise<void> | null;
	all(sql: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

/** Rows as plain numbers and strings, with `numRows` and `get` like a result table. */
function asTable(rows: Record<string, unknown>[]) {
	const plain = rows.map((r) =>
		Object.fromEntries(
			Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
		)
	);
	return Object.assign(plain, { numRows: plain.length, get: (i: number) => plain[i] });
}

function openConn(): TestConn {
	const db = new duckdb.Database(':memory:');
	const all = (sql: string) =>
		new Promise<Record<string, unknown>[]>((res, rej) =>
			db.all(sql, (e: Error | null, rows: Record<string, unknown>[]) => (e ? rej(e) : res(rows)))
		);
	const queries: string[] = [];
	const conn: TestConn = {
		queries,
		gate: null,
		queryGate: null,
		all,
		async query(sql: string) {
			queries.push(sql);
			if (conn.queryGate) await conn.queryGate;
			return asTable(await all(sql)) as never;
		},
		async exec(sql: string) {
			queries.push(sql);
			if (conn.gate && sql.startsWith('CREATE TABLE IF NOT EXISTS "__dplot_preagg_')) {
				await conn.gate;
			}
			await new Promise<void>((res, rej) =>
				db.exec(sql, (e: Error | null) => (e ? rej(e) : res()))
			);
		},
		close: () =>
			new Promise<void>((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
	return conn;
}

/** Hold preagg builds once started until the returned function is called. */
function holdBuilds(): () => void {
	let release!: () => void;
	conn.gate = new Promise((r) => (release = r));
	return () => {
		conn.gate = null;
		release();
	};
}

let conn: TestConn;
let engine: QueryEngine;
let group: FilterGroup;

/** A fresh engine and filter group on the connection, with the dims set up. */
async function useEngine(options?: QueryEngineOptions): Promise<void> {
	engine = new QueryEngine(conn, options);
	group = new FilterGroup();
	group.setEngine(engine);
	// The dims a legend or band axis on these fields would have built.
	await engine.ensureColumns('t', { categorical: ['cat'] });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	// A failed build only warns and falls back to the base table, so no test
	// would notice it; afterEach fails any test whose builds failed.
	warn = vi.spyOn(console, 'warn');
	conn = openConn();
	await conn.exec!(SEED_SQL);
	await useEngine();
});

afterEach(async () => {
	const failed = warn.mock.calls.filter((args) => String(args[0]).includes('preagg failed'));
	warn.mockRestore();
	await engine.destroy();
	expect(failed.map((args) => String(args[1]))).toEqual([]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const idOf = (field: string) => engine.identityColumn(field);

/** Register a mark and wait for its first result. */
async function mark(
	id: string,
	select: Record<string, unknown>,
	opts: {
		table?: string;
		baseTable?: string;
		limit?: number;
		reads?: string[];
		transforms?: { transforms: Transform[]; config: MarkConfig };
		into?: FilterGroup;
		chart?: object;
		response?: 'auto' | 'filter';
		nullDrops?: NullDrop[];
		bins?: Record<string, BinPadding>;
	} = {}
): Promise<MarkHandle> {
	const baseTable = opts.baseTable ?? 't';
	const descriptor: QueryDescriptor = {
		table: opts.table ?? baseTable,
		baseTable,
		parts: {
			...buildQueryParts(select, null, !!opts.transforms),
			...(opts.nullDrops ? { nullDrops: opts.nullDrops } : {}),
			...(opts.bins ? { bins: opts.bins } : {})
		},
		schema: new Map(),
		transformCompiler: new TransformCompiler(
			opts.transforms?.transforms ?? [],
			opts.transforms?.config
		),
		route: { reads: opts.reads ?? [], chart: opts.chart ?? null, response: opts.response }
	};
	const handle = engine.registerMark(id, descriptor, opts.into ?? group);
	await settle([handle], () => handle.updateParams({ sort: undefined, limit: opts.limit }));
	return handle;
}

/** Run an action and wait for every handle's next result. */
async function settle(handles: MarkHandle[], action: () => void): Promise<void> {
	const versions = handles.map((h) => h.dataVersion);
	action();
	await vi.waitFor(() =>
		handles.forEach((h, i) => expect(h.dataVersion).toBeGreaterThan(versions[i]))
	);
}

/** A handle's rows, sorted, as arrays of values. */
function rowsOf(handle: MarkHandle): unknown[][] {
	const table = handle.arrowTable as unknown as Record<string, unknown>[];
	return table.map((r) => Object.values(r).map(Number)).sort(byValues);
}

async function expected(sql: string): Promise<unknown[][]> {
	return (await conn.all(sql)).map((r) => Object.values(r).map(Number)).sort(byValues);
}

function byValues(a: unknown[], b: unknown[]): number {
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number) ? -1 : 1;
	}
	return 0;
}

const nonDDL = () => conn.queries.filter((q) => !/^(CREATE|INSERT|DROP)/.test(q));
const creates = () =>
	conn.queries.filter((q) => q.startsWith('CREATE TABLE IF NOT EXISTS "__dplot_preagg_'));

/** The last query of each mark since `from`, by the mark's distinctive select. */
function lastQueriesSince(from: number): string[] {
	return nonDDL().slice(from);
}

/** Activate a toggle source on `fields` for every aggregate mark, as a legend hover does. */
function activateToggle(fields: string[]): Promise<void> {
	return engine.activate(group, {
		sourceId: fields.length === 1 ? `toggle-${fields[0]}` : `toggle-${JSON.stringify(fields)}`,
		categoricalKey: null,
		dims: fields.map((field) => ({ kind: 'value' as const, field }))
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('a histogram padded to every bin', () => {
	// x: 0..999 in 20 bins of 50. Selecting g = 0 keeps x < 250, which empties
	// bins 5..19: they must come back as zero rows, in bin order, from the
	// preagg table exactly as from the base table.
	const stats = { x: { min: 0, max: 999 } };
	const lower = bin('x', { steps: 20 });
	const upper = lower.withOffset(1);
	const select = {
		x1: castReal(lower.resolve(stats, 'linear')),
		x2: castReal(upper.resolve(stats, 'linear')),
		y: count()
	};
	const bins = { x1: lower.padding(stats, 'linear')!, x2: upper.padding(stats, 'linear')! };
	const transforms = {
		transforms: [dense()],
		config: { markType: 'recty', table: 't' } as MarkConfig
	};
	/** A handle's rows in result order, which is what the GPU gets. */
	const ordered = (handle: MarkHandle) =>
		(handle.arrowTable as unknown as Record<string, unknown>[]).map((r) =>
			Object.values(r).map(Number)
		);

	it('enumerates the bins binHistogram produces', async () => {
		expect(bins.x1).toEqual({ kind: 'number', min: 0, alpha: 50, count: 20, offset: 0 });
		expect(bins.x2.offset).toBe(1);
		const edges = await conn.all(
			`SELECT DISTINCT CAST(${lower.resolve(stats, 'linear')} AS DOUBLE) AS e FROM t ORDER BY e`
		);
		expect(edges.map((r) => r.e)).toEqual(Array.from({ length: 20 }, (_, k) => 50 * k));
	});

	it('reads a preagg table padded like the base read, zeros in place, as REAL', async () => {
		await engine.ensureColumns('t', { categorical: ['g'] });
		const viaPreagg = await mark('hist-padded', select, { transforms, bins });
		const reference = new FilterGroup();
		reference.setEngine(engine);
		const viaBase = await mark('hist-padded-ref', select, { transforms, bins, into: reference });

		await activateToggle(['g']);
		const toggle = group.registerToggle('g');
		const referenceToggle = reference.registerToggle('g');
		await settle([viaPreagg], () => toggle.set([[0]]));
		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		await settle([viaBase], () => referenceToggle.set([[0]]));
		expect(nonDDL().at(-1)).not.toContain('__dplot_preagg_');

		const rows = ordered(viaPreagg);
		expect(rows).toEqual(ordered(viaBase));
		expect(rows).toHaveLength(20);
		expect(rows.map((r) => r[0])).toEqual(Array.from({ length: 20 }, (_, k) => 50 * k));
		expect(rows.map((r) => r[1])).toEqual(Array.from({ length: 20 }, (_, k) => 50 * (k + 1)));
		expect(rows.map((r) => r[2])).toEqual(Array.from({ length: 20 }, (_, k) => (k < 5 ? 50 : 0)));

		// Every channel stays a REAL, so it reaches the GPU without a copy.
		const types = await conn.all(`DESCRIBE ${nonDDL().at(-1)}`);
		expect(types.map((t) => t.column_type)).toEqual(['FLOAT', 'FLOAT', 'FLOAT']);
	});

	it('pads monthly time buckets the same way, months not being a fixed width', async () => {
		// 400 days from 2024-01-01: 14 months. g = 0 keeps the first 100 days, so
		// January to April have rows and the ten months after come back as zeros.
		await conn.exec!(
			`CREATE TABLE days AS SELECT CAST(DATE '2024-01-01' + INTERVAL (i) DAY AS DATE) AS d, i // 100 AS g FROM range(400) r(i)`
		);
		await engine.ensureColumns('days', { categorical: ['g'] });
		const minMs = Date.UTC(2024, 0, 1);
		const maxMs = minMs + 399 * 86_400_000;
		const t0 = minMs / 1000;
		const dayStats = { d: { min: minMs, max: maxMs, type: 'date' } };
		const month = bin('d', { interval: 'month' });
		const next = month.withOffset(1);
		// The rewrite a time channel gets in the query: seconds from t0.
		const seconds = (node: ExprNode) => castReal(sql`CAST((epoch(${node}) - ${t0}) AS REAL)`);
		const timeSelect = {
			x1: seconds(month.resolve(dayStats, 'time')),
			x2: seconds(next.resolve(dayStats, 'time')),
			y: count()
		};
		const timeBins = {
			x1: month.padding(dayStats, 'time', null, 1, t0)!,
			x2: next.padding(dayStats, 'time', null, 1, t0)!
		};
		expect(timeBins.x1).toMatchObject({ kind: 'time', interval: 'INTERVAL 1 month', offset: 0 });
		// No origin yet, no padding: the channel is not rewritten either.
		expect(month.padding(dayStats, 'time')).toBeNull();

		const opts = { baseTable: 'days', transforms, bins: timeBins };
		const viaPreagg = await mark('months', timeSelect, opts);
		const reference = new FilterGroup();
		reference.setEngine(engine);
		const viaBase = await mark('months-ref', timeSelect, { ...opts, into: reference });

		await activateToggle(['g']);
		const toggle = group.registerToggle('g');
		const referenceToggle = reference.registerToggle('g');
		await settle([viaPreagg], () => toggle.set([[0]]));
		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		await settle([viaBase], () => referenceToggle.set([[0]]));

		const rows = ordered(viaPreagg);
		expect(rows).toEqual(ordered(viaBase));
		const monthStart = (m: number) => (Date.UTC(2024, m, 1) - minMs) / 1000;
		expect(rows.map((r) => r[0])).toEqual(Array.from({ length: 14 }, (_, m) => monthStart(m)));
		expect(rows.map((r) => r[1])).toEqual(Array.from({ length: 14 }, (_, m) => monthStart(m + 1)));
		expect(rows.map((r) => r[2])).toEqual([31, 29, 31, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
	});
});

describe('preagg for value dims', () => {
	it('legend hover then click: every case reads a preagg table and matches the base query', async () => {
		const view = engine.identitySourceFor('t');
		// Case 1: bars by cat's id, read from the view.
		const bars = await mark(
			'bars',
			{ x: castReal(column(idOf('cat'))), n: count() },
			{ table: view }
		);
		// Case 2 (join): a histogram on the bare table.
		const hist = await mark('hist', { g: column('g'), n: count() });
		// Case 2 (view shortcut): the same histogram read from the view.
		const histView = await mark('hist-view', { g: column('g'), n: count() }, { table: view });

		await activateToggle(['cat']);
		expect(creates()).toHaveLength(3);
		expect(creates().some((c) => c.includes('LEFT JOIN'))).toBe(true);

		const legend = group.registerToggle('cat');
		const from = nonDDL().length;
		await settle([bars, hist, histView], () => legend.toggle(['a'], false));

		const after = lastQueriesSince(from);
		expect(after.length).toBeGreaterThanOrEqual(3);
		expect(after.every((q) => q.includes('__dplot_preagg_'))).toBe(true);
		const aId = engine.identityFor('cat').ids.get('a');
		expect(rowsOf(bars)).toEqual(await expected(`SELECT ${aId}, count(*) FROM t WHERE cat = 'a'`));
		const histRows = await expected(`SELECT g, count(*) FROM t WHERE cat = 'a' GROUP BY g`);
		expect(rowsOf(hist)).toEqual(histRows);
		expect(rowsOf(histView)).toEqual(histRows);
	});

	it('a mark that filters by a field it draws reads the same rows through preagg, top N with Other', async () => {
		// selectionResponse 'filter': no reads, so a toggle on the field it is
		// coloured by filters it, though the legend sits in the mark's own
		// chart. Bars by kind, top 1 plus Other, coloured by cat.
		await engine.ensureColumns('t', { categorical: ['cat', 'kind'] });
		const { id: otherId } = await engine.acquireSyntheticIdentity('kind', 'Other');
		const view = engine.identitySourceFor('t');
		const select = {
			x: castReal(column(idOf('kind'))),
			fill: castReal(column(idOf('cat'))),
			n: count()
		};
		const transforms = {
			transforms: [topN(1, { includeOthers: true })],
			config: {
				markType: 'bar',
				table: 't',
				x: 'x',
				y: 'n',
				fill: 'fill',
				groupKeys: ['x', 'fill'],
				identity: {
					x: { dim: engine.dimTableFor('kind'), size: otherId + 1, positional: true, otherId }
				}
			} as MarkConfig
		};
		const chart = { name: 'bars' };
		const own = { table: view, transforms, chart, response: 'filter' as const };
		const viaPreagg = await mark('bars', select, own);
		// The same mark in a group that never activates: it reads the base table.
		const reference = new FilterGroup();
		reference.setEngine(engine);
		const viaBase = await mark('bars-ref', select, { ...own, into: reference });

		await engine.activate(group, {
			sourceId: 'toggle-cat',
			categoricalKey: 'cat',
			dims: [{ kind: 'value', field: 'cat' }]
		});
		expect(creates()).toHaveLength(1);

		const legend = group.registerToggle('cat', { chart });
		const referenceLegend = reference.registerToggle('cat', { chart });
		await settle([viaPreagg], () => legend.toggle(['a'], false));
		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		await settle([viaBase], () => referenceLegend.toggle(['a'], false));
		expect(nonDDL().at(-1)).not.toContain('__dplot_preagg_');

		expect(rowsOf(viaPreagg)).toEqual(rowsOf(viaBase));
		// Top 1 kind within cat 'a', plus Other: two rows.
		expect(rowsOf(viaPreagg)).toHaveLength(2);
	});

	it('serves a nulls="drop" mark from preagg: the dropped group goes at read time', async () => {
		// The preagg table is unfiltered and shared, and keeps NULL as its own
		// group: kind is a group key. The drop is read through the preagg select.
		await engine.ensureColumns('t', { categorical: ['cat', 'kind'] });
		const view = engine.identitySourceFor('t');
		const nullId = engine.identityFor('kind').nullId;
		expect(nullId).not.toBeNull();
		const bars = await mark(
			'kind-drop',
			{ x: castReal(column(idOf('kind'))), n: count() },
			{ table: view, nullDrops: [{ channel: 'x', nullId }] }
		);
		const raw = await mark(
			'g-drop',
			{ g: column('g'), n: count() },
			{ nullDrops: [{ channel: 'g', nullId: null }] }
		);
		await activateToggle(['cat']);

		const legend = group.registerToggle('cat');
		const from = nonDDL().length;
		await settle([bars, raw], () => legend.toggle(['a'], false));
		const after = lastQueriesSince(from);
		expect(after.length).toBeGreaterThanOrEqual(2);
		expect(after.every((q) => q.includes('__dplot_preagg_'))).toBe(true);

		// The base query's answer, on the view's id column with NULL left out.
		const expectedBars = await expected(
			`SELECT "${idOf('kind')}", count(*) FROM "${view}" WHERE cat = 'a' AND kind IS NOT NULL GROUP BY 1`
		);
		const sort = (rows: unknown[][]) => [...rows].sort((a, b) => Number(a[0]) - Number(b[0]));
		expect(sort(rowsOf(bars))).toEqual(sort(expectedBars));
		expect(rowsOf(bars).some(([x]) => Number(x) === nullId)).toBe(false);
		expect(rowsOf(raw)).toEqual(
			await expected(`SELECT g, count(*) FROM t WHERE cat = 'a' AND g IS NOT NULL GROUP BY g`)
		);
	});

	it("serves a mark with filter() from preagg: the mark's own filter is in the table, not the read", async () => {
		// The table groups the source rows, so a WHERE on a raw column (x here, which
		// the table does not hold) only works inside the build.
		const transforms = {
			transforms: [filter(gt('x', 499))],
			config: { markType: 'bar', table: 't', x: 'g', y: 'n' } as MarkConfig
		};
		const hist = await mark('hist-filter', { g: column('g'), n: count() }, { transforms });
		await activateToggle(['cat']);
		expect(creates()).toHaveLength(1);
		expect(creates()[0]).toMatch(/WHERE.*"x" > 499/);

		const legend = group.registerToggle('cat');
		const from = nonDDL().length;
		await settle([hist], () => legend.toggle(['a'], false));
		expect(lastQueriesSince(from).at(-1)).toContain('__dplot_preagg_');
		expect(warn.mock.calls.some((args) => String(args[0]).includes('preagg read failed'))).toBe(
			false
		);
		expect(rowsOf(hist)).toEqual(
			await expected(`SELECT g, count(*) FROM t WHERE x > 499 AND cat = 'a' GROUP BY g`)
		);
	});

	it('reads the base table for a mark with having(): a table would count its groups, not the rows', async () => {
		const transforms = {
			transforms: [having(gt(count(), 100))],
			config: { markType: 'bar', table: 't', x: 'g', y: 'n' } as MarkConfig
		};
		const hist = await mark('hist-having', { g: column('g'), n: count() }, { transforms });
		await activateToggle(['cat']);
		expect(creates()).toHaveLength(0);

		const legend = group.registerToggle('cat');
		const from = nonDDL().length;
		await settle([hist], () => legend.toggle(['a'], false));
		expect(lastQueriesSince(from).at(-1)).not.toContain('__dplot_preagg_');
		// Each g holds 125 rows of cat 'a', over the threshold of 100.
		expect(rowsOf(hist)).toEqual(
			await expected(`SELECT g, count(*) FROM t WHERE cat = 'a' GROUP BY g HAVING count(*) > 100`)
		);
		expect(rowsOf(hist)).toHaveLength(4);
	});

	it('serves a selection of hundreds of values (a large Other) with a bitmap, not a long IN', async () => {
		// big: 100 000 rows, 1 000 values of x, so a table grouped by x pays off.
		await engine.ensureColumns('big', { categorical: ['x'] });
		const hist = await mark('hist-many', { g: column('g'), n: count() }, { baseTable: 'big' });
		await activateToggle(['x']);

		const toggle = group.registerToggle('x');
		const picked = Array.from({ length: 300 }, (_, i) => i * 3);
		const from = nonDDL().length;
		await settle([hist], () => toggle.set(picked.map((v) => [v])));
		const last = lastQueriesSince(from).at(-1)!;
		expect(last).toContain('__dplot_preagg_');
		expect(last).toContain('get_bit(');
		expect(last).not.toMatch(/NOT IN/);
		expect(rowsOf(hist)).toEqual(
			await expected(`SELECT g, count(*) FROM big WHERE x IN (${picked.join(',')}) GROUP BY g`)
		);
	});

	it('a legend hover builds no table for a mark that reads the field, which dims instead', async () => {
		const view = engine.identitySourceFor('t');
		const bars = await mark(
			'bars',
			{ x: castReal(column(idOf('cat'))), n: count() },
			{ table: view, reads: ['cat'] }
		);
		const hist = await mark('hist', { g: column('g'), n: count() });

		await engine.activate(group, {
			sourceId: 'toggle-cat',
			categoricalKey: 'cat',
			dims: [{ kind: 'value', field: 'cat' }]
		});
		// Only the histogram, which the selection filters, gets a table.
		expect(creates()).toHaveLength(1);

		const barsVersion = bars.dataVersion;
		const legend = group.registerToggle('cat');
		await settle([hist], () => legend.toggle(['a'], false));
		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		// The bars are not re-queried: their data is the whole dataset, dimmed.
		expect(bars.dataVersion).toBe(barsVersion);
	});

	it('an empty toggle reads the table with no filter: every category', async () => {
		const hist = await mark('hist', { g: column('g'), n: count() });
		await activateToggle(['cat']);
		const legend = group.registerToggle('cat');
		await settle([hist], () => legend.toggle(['a'], false));
		await settle([hist], () => legend.clear());

		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		expect(rowsOf(hist)).toEqual(await expected(`SELECT g, count(*) FROM t GROUP BY g`));
	});

	it('case 3: a field with no dim filters its values with the toggle predicate', async () => {
		const hist = await mark('hist', { g: column('g'), n: count() });
		await activateToggle(['kind']);
		const toggle = group.registerToggle('kind');
		await settle([hist], () => toggle.set([['p'], ['r']]));

		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		expect(rowsOf(hist)).toEqual(
			await expected(`SELECT g, count(*) FROM t WHERE kind IN ('p', 'r') GROUP BY g`)
		);
	});

	it('a multi-field toggle with a NULL member matches the base query', async () => {
		const hist = await mark('hist', { g: column('g'), n: count() });
		await activateToggle(['cat', 'kind']);
		const toggle = group.registerToggle(['cat', 'kind'], {});
		await settle([hist], () =>
			toggle.set([
				['a', null],
				['b', 'q']
			])
		);

		// cat has ids, kind has none: the NULL stays a NULL in kind's raw column.
		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		expect(rowsOf(hist)).toEqual(
			await expected(
				`SELECT g, count(*) FROM t WHERE (cat = 'a' AND kind IS NULL) OR (cat = 'b' AND kind = 'q') GROUP BY g`
			)
		);
	});

	it('a value with no id falls back to the base table rather than filter wrongly', async () => {
		const hist = await mark('hist', { g: column('g'), n: count() });
		await activateToggle(['cat']);
		const toggle = group.registerToggle('cat');
		await settle([hist], () => toggle.set([['zzz']]));

		expect(nonDDL().at(-1)).not.toContain('__dplot_preagg_');
		expect(rowsOf(hist)).toEqual([]);
	});

	it('a mark on a table its dim does not cover uses raw values, and stays exact as the dim grows', async () => {
		await conn.exec!(
			`CREATE TABLE u AS SELECT * FROM (VALUES ('a', 0), ('c', 1), ('c', 1)) v(cat, g)`
		);
		const hist = await mark('hist-u', { g: column('g'), n: count() }, { baseTable: 'u' });
		await activateToggle(['cat']);
		expect(creates().at(-1)).not.toContain('LEFT JOIN');

		// Another registration folds u into the dim; 'c' gets an id now.
		await engine.ensureColumns('u', { categorical: ['cat'] });
		const toggle = group.registerToggle('cat');
		await settle([hist], () => toggle.toggle(['c'], false));

		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		expect(rowsOf(hist)).toEqual([[1, 2]]);
	});

	it('an expression field filters through its identity SQL', async () => {
		const field = 'upper("cat")';
		await engine.ensureColumns('t', { categorical: [{ key: field, sql: field }] });
		const hist = await mark('hist', { g: column('g'), n: count() });
		await activateToggle([field]);
		const toggle = group.registerToggle(field);
		await settle([hist], () => toggle.toggle(['A'], false));

		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		expect(rowsOf(hist)).toEqual(
			await expected(`SELECT g, count(*) FROM t WHERE upper(cat) = 'A' GROUP BY g`)
		);
	});

	it('a channel computed from an id column is not taken for the id channel', async () => {
		const view = engine.identitySourceFor('t');
		const id = idOf('cat');
		// x holds id + 1, not the id: filtering x by ids would select the wrong
		// category. It is grouped like any other channel, and the toggle gets its
		// own id column.
		const bars = await mark('shifted', { x: sql`${column(id)} + 1`, n: count() }, { table: view });
		await activateToggle(['cat']);
		const toggle = group.registerToggle('cat');
		await settle([bars], () => toggle.toggle(['a'], false));

		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		expect(rowsOf(bars)).toEqual(
			await expected(`SELECT "${id}" + 1, count(*) FROM "${view}" WHERE cat = 'a' GROUP BY 1`)
		);
	});

	it('a field named like a channel does not collide in the preagg table', async () => {
		const bars = await mark('bars-x', { x: column('g'), n: count() });
		await activateToggle(['x']);
		const toggle = group.registerToggle('x');
		await settle([bars], () => toggle.set([[5], [600]]));

		expect(nonDDL().at(-1)).toContain('__dplot_preagg_');
		expect(rowsOf(bars)).toEqual(
			await expected(`SELECT g, count(*) FROM t WHERE x IN (5, 600) GROUP BY g`)
		);
	});

	it('activation never creates a view or extends a dim', async () => {
		await mark('hist', { g: column('g'), n: count() });
		const before = conn.queries.length;
		await activateToggle(['cat']);
		await activateToggle(['kind']);

		const ddl = conn.queries.slice(before);
		expect(ddl.some((q) => q.includes('CREATE OR REPLACE VIEW'))).toBe(false);
		expect(ddl.some((q) => q.startsWith('INSERT INTO "__dplot_dim'))).toBe(false);
		expect(ddl.some((q) => q.includes('CREATE TABLE IF NOT EXISTS "__dplot_dim'))).toBe(false);
	});
});

describe('the size guard', () => {
	/** Wait for the base table row counts started at registration. */
	const counted = () =>
		vi.waitFor(() => expect(conn.queries.some((q) => q.startsWith('SELECT count(*)'))).toBe(true));

	it('estimates a limited mark from its dims, not its few result rows, and skips it', async () => {
		await engine.ensureColumns('t', { categorical: ['x'] });
		const view = engine.identitySourceFor('t');
		// 1000 x ids per row-limited result of 5 rows; cat adds 3 groups: 3003 > 1000 / 4.
		await mark('top', { x: castReal(column(idOf('x'))), n: count() }, { table: view, limit: 5 });
		await counted();
		await new Promise((r) => setTimeout(r, 20));

		await activateToggle(['cat']);
		expect(creates()).toHaveLength(0);
	});

	it('skips a bin build planned at deep zoom over a wide data extent', async () => {
		await mark('hist', { g: column('g'), n: count() });
		await counted();
		await new Promise((r) => setTimeout(r, 20));

		// 50 bins per unit over a 1000-wide extent, times 4 groups.
		await engine.activate(group, {
			sourceId: 'interval-x-A',
			categoricalKey: null,
			dims: [
				{
					kind: 'bin',
					columnRef: column('x'),
					domain: [0, 20],
					pixelExtent: 1000,
					extent: [0, 1000]
				}
			]
		});
		expect(creates()).toHaveLength(0);
	});

	it('the same estimate is skipped on a small base table and built on a large one', async () => {
		await engine.ensureColumns('t', { categorical: ['x'] });
		await engine.ensureColumns('big', { categorical: ['x'] });
		// 4 g-groups × 1001 x ids = 4004: over 1000 / 4, under 100,000 / 4.
		await mark('small', { g: column('g'), n: count() });
		await mark('large', { g: column('g'), n: count() }, { baseTable: 'big' });
		await vi.waitFor(() =>
			expect(conn.queries.filter((q) => q.startsWith('SELECT count(*)'))).toHaveLength(2)
		);
		await new Promise((r) => setTimeout(r, 20));

		await activateToggle(['x']);
		expect(creates()).toHaveLength(1);
		expect(creates()[0]).toContain('"big"');
	});

	it('builds a table between a tenth and a quarter of the base rows', async () => {
		await mark('large', { g: column('g'), n: count() }, { baseTable: 'big' });
		await counted();
		await new Promise((r) => setTimeout(r, 20));

		// 3001 bins over the data extent × 4 g-groups ≈ 12,000: over 100,000 / 10,
		// under 100,000 / 4. Measured, such a table still clicks ~3.7× faster.
		await engine.activate(group, {
			sourceId: 'interval-x-B',
			categoricalKey: null,
			dims: [
				{
					kind: 'bin',
					columnRef: column('x'),
					domain: [0, 1000],
					pixelExtent: 3000,
					extent: [0, 1000]
				}
			]
		});
		expect(creates()).toHaveLength(1);
	});

	it('uses the fixed cap before the row count arrives, the relative cap after', async () => {
		await engine.ensureColumns('t', { categorical: ['x'] });
		// Group keys all id channels, so the estimate needs no result:
		// 1001 x ids × 3 cat groups = 3003, under 100,000 but over 1000 / 4.
		const descriptor: QueryDescriptor = {
			table: engine.identitySourceFor('t'),
			baseTable: 't',
			parts: buildQueryParts({ x: castReal(column(idOf('x'))), n: count() }, null, false),
			schema: new Map(),
			transformCompiler: new TransformCompiler([])
		};
		// Registered and activated in the same tick: the count is still in flight.
		engine.registerMark('early', descriptor, group);
		await activateToggle(['cat']);
		expect(creates()).toHaveLength(1);

		await counted();
		await new Promise((r) => setTimeout(r, 20));
		engine.forgetSource(group, 'toggle-cat');
		await activateToggle(['cat']);
		expect(creates()).toHaveLength(1);
	});

	it('counts a field shown on two channels once', async () => {
		await engine.ensureColumns('big', { categorical: ['x', 'cat'] });
		const view = engine.identitySourceFor('big');
		const x = castReal(column(idOf('x')));
		// Bars colored by their own field: 1001 x groups, not 1001², times 3 cat
		// groups is 3003, well under 100,000 / 4. Squared it would be about 3M.
		await mark('bars', { x, fill: x, n: count() }, { table: view, baseTable: 'big' });
		await counted();
		await new Promise((r) => setTimeout(r, 20));

		await activateToggle(['cat']);
		expect(creates()).toHaveLength(1);
	});

	it('adds a bin dim on a column the mark already groups by instead of multiplying', async () => {
		// A histogram of x in 50 bins, brushed on x at 3 px per unit: about 3001
		// pixel bins, each in about one histogram bin, so 50 + 3001 groups, not
		// 50 × 3001 = 150,050 (over 100,000 / 4).
		await mark('hist', { b: sql`floor(${column('x')} / 20)`, n: count() }, { baseTable: 'big' });
		await counted();
		await new Promise((r) => setTimeout(r, 20));

		await engine.activate(group, {
			sourceId: 'interval-x-B',
			categoricalKey: null,
			dims: [
				{
					kind: 'bin',
					columnRef: column('x'),
					domain: [0, 1000],
					pixelExtent: 3000,
					extent: [0, 1000]
				}
			]
		});
		expect(creates()).toHaveLength(1);
	});

	it('reads each base table’s row count once', async () => {
		await mark('one', { g: column('g'), n: count() });
		await mark('two', { g: column('g'), n: count() });
		await counted();
		expect(conn.queries.filter((q) => q.startsWith('SELECT count(*)'))).toHaveLength(1);
	});
});

describe('the build queue', () => {
	const createIndexes = () =>
		conn.queries.flatMap((q, i) =>
			q.startsWith('CREATE TABLE IF NOT EXISTS "__dplot_preagg_') ? [i] : []
		);

	it('a build waits while a mark query is in flight', async () => {
		// No wait limit here: this checks the hold itself.
		await useEngine({ buildMaxWaitMs: Infinity });
		const byG = await mark('by-g', { g: column('g'), n: count() });
		const byKind = await mark('by-kind', { kind: column('kind'), n: count() });

		const release = holdBuilds();
		const building = activateToggle(['cat']);
		await vi.waitFor(() => expect(createIndexes()).toHaveLength(1));

		// Mark queries held in flight while the first build finishes. A params
		// change re-queries without touching any clause, so the queued build stays
		// valid (a filter change would make the dequeue check drop it).
		let releaseQueries!: () => void;
		conn.queryGate = new Promise((r) => (releaseQueries = r));
		const queriesFrom = conn.queries.length;
		const settled = settle([byG, byKind], () => {
			byG.updateParams({ sort: undefined, limit: 100 });
			byKind.updateParams({ sort: undefined, limit: 100 });
		});
		await vi.waitFor(() => expect(conn.queries.length).toBeGreaterThanOrEqual(queriesFrom + 2));

		release();
		await new Promise((r) => setTimeout(r, 50));
		// The first build is done, but the queries are still in flight.
		expect(createIndexes()).toHaveLength(1);

		conn.queries.push('-- queries released');
		const marker = conn.queries.length - 1;
		conn.queryGate = null;
		releaseQueries();
		await settled;
		await building;

		const [, second] = createIndexes();
		expect(second).toBeGreaterThan(marker);
	});

	it('a build waits at most the limit while mark queries keep coming (a drag on the base table)', async () => {
		await useEngine({ buildMaxWaitMs: 30 });
		const byG = await mark('by-g', { g: column('g'), n: count() });
		await mark('by-kind', { kind: column('kind'), n: count() });

		// A mark query held in flight for the whole test, as a drag keeps one.
		let releaseQueries!: () => void;
		conn.queryGate = new Promise((r) => (releaseQueries = r));
		const queriesFrom = conn.queries.length;
		const settled = settle([byG], () => byG.updateParams({ sort: undefined, limit: 100 }));
		await vi.waitFor(() => expect(conn.queries.length).toBeGreaterThan(queriesFrom));

		const building = activateToggle(['cat']);
		// Past the limit the build is sent although the query is still in flight.
		await vi.waitFor(() => expect(createIndexes().length).toBeGreaterThan(0), { timeout: 1000 });

		conn.queryGate = null;
		releaseQueries();
		await settled;
		await building;
	});

	it('a newer hover drops queued builds of the older one, but not of its own sources', async () => {
		await mark('by-g', { g: column('g'), n: count() });
		await mark('by-kind', { kind: column('kind'), n: count() });

		const release = holdBuilds();
		const first = activateToggle(['cat']);
		await vi.waitFor(() => expect(createIndexes()).toHaveLength(1));

		// One hover over a chart with a Toggle on kind and a brush on x.
		let second!: Promise<unknown>;
		engine.batch(() => {
			second = Promise.all([
				activateToggle(['kind']),
				engine.activate(group, {
					sourceId: 'interval-x-A',
					categoricalKey: null,
					// Coarse bins, so the size guard lets the build through on 1,000 rows.
					dims: [
						{
							kind: 'bin',
							columnRef: column('x'),
							domain: [0, 1000],
							pixelExtent: 20,
							extent: [0, 999]
						}
					]
				})
			]);
		});
		release();
		await Promise.all([first, second]);

		const built = conn.queries.filter((q) =>
			q.startsWith('CREATE TABLE IF NOT EXISTS "__dplot_preagg_')
		);
		// cat: only the build already running; kind and the brush: both marks each.
		expect(built.filter((q) => q.includes('LEFT JOIN'))).toHaveLength(1);
		expect(built.filter((q) => q.includes('"kind" AS "__active0"'))).toHaveLength(2);
		expect(built.filter((q) => q.includes('floor('))).toHaveLength(2);
	});

	it('a bin build whose view zoomed in while it waited is skipped', async () => {
		await mark('by-g', { g: column('g'), n: count() });
		await mark('by-kind', { kind: column('kind'), n: count() });

		let view = [0, 1000, 20];
		const release = holdBuilds();
		const building = engine.activate(group, {
			sourceId: 'interval-x-A',
			categoricalKey: null,
			dims: [
				{
					kind: 'bin',
					columnRef: column('x'),
					domain: [0, 1000],
					pixelExtent: 20,
					extent: [0, 999]
				}
			],
			view: (out) => out.set(view)
		});
		await vi.waitFor(() => expect(createIndexes()).toHaveLength(1));

		// A zoom in while the second build waits: its bins would be too coarse.
		view = [0, 100, 20];
		release();
		await building;

		expect(createIndexes()).toHaveLength(1);
	});

	it('a build whose baked filters changed while it waited is skipped', async () => {
		await mark('by-g', { g: column('g'), n: count() });
		await mark('by-kind', { kind: column('kind'), n: count() });

		const release = holdBuilds();
		const building = activateToggle(['cat']);
		await vi.waitFor(() => expect(createIndexes()).toHaveLength(1));

		// A clause the queued build bakes in changes before it starts.
		group.registerToggle('kind').set([['p']]);
		release();
		await building;

		expect(createIndexes()).toHaveLength(1);
	});
});

// Each test builds about 40 tables (~2.5 s): a timeout with room for a busy machine.
describe('the cap on unused preagg tables', { timeout: 20_000 }, () => {
	const tableOf = (q: string) => q.match(/"(__dplot_preagg_[0-9a-f]+)"/)![1];
	const drops = () =>
		conn.queries.filter((q) => q.startsWith('DROP TABLE IF EXISTS "__dplot_preagg_')).map(tableOf);

	/** A new baked filter, set without waiting for the mark's query. */
	const filterTo = (hi: number) => group.upsertManual('f', isBetween(column('x'), [0, hi]), hi);

	/** Rebuild the cat toggle's table under the `i`th filter: one new table per call. */
	async function rebuildUnder(i: number, handle: MarkHandle): Promise<void> {
		await settle([handle], () => filterTo(999 - i));
		await activateToggle(['cat']);
	}

	it('keeps at most 32 unused tables, dropping the oldest, never one in use', async () => {
		const byG = await mark('by-g', { g: column('g'), n: count() });
		for (let i = 0; i < 40; i++) await rebuildUnder(i, byG);

		const built = creates().map(tableOf);
		expect(built).toHaveLength(40);
		// 40 tables, one in use: 39 unused, 7 past the cap, the oldest first.
		expect(drops()).toEqual(built.slice(0, 7));
		expect(drops()).not.toContain(built.at(-1));
	});

	it('drops nothing while a mark query is waiting, and catches up once it settles', async () => {
		const byG = await mark('by-g', { g: column('g'), n: count() });
		for (let i = 0; i < 33; i++) await rebuildUnder(i, byG);
		expect(drops()).toHaveLength(0); // 33 tables, 32 unused: at the cap

		// The 34th table while the mark's query is held: past the cap, but busy.
		let releaseQueries!: () => void;
		conn.queryGate = new Promise((r) => (releaseQueries = r));
		const settled = settle([byG], () => filterTo(999 - 33));
		await activateToggle(['cat']);
		expect(drops()).toHaveLength(0);

		conn.queryGate = null;
		releaseQueries();
		await settled;
		await vi.waitFor(() => expect(drops()).toHaveLength(1));
	});

	it('rebuilds a dropped table when it is planned again', async () => {
		const byG = await mark('by-g', { g: column('g'), n: count() });
		for (let i = 0; i < 40; i++) await rebuildUnder(i, byG);
		const first = creates().map(tableOf)[0];
		expect(drops()).toContain(first);

		// The first filter again: the same SQL, so the same table name, built anew.
		await rebuildUnder(0, byG);
		expect(
			creates()
				.map(tableOf)
				.filter((t) => t === first)
		).toHaveLength(2);

		const toggle = group.registerToggle('cat');
		await settle([byG], () => toggle.toggle(['a'], false));
		expect(nonDDL().at(-1)).toContain(first);
		expect(rowsOf(byG)).toEqual(
			await expected(`SELECT g, count(*) FROM t WHERE x BETWEEN 0 AND 999 AND cat = 'a' GROUP BY g`)
		);
	});
});

describe('a failed preagg read', () => {
	it('falls back to the base table, and reads a preagg table again once rebuilt', async () => {
		const hist = await mark('hist', { g: column('g'), n: count() });
		await activateToggle(['cat']);
		const legend = group.registerToggle('cat');
		await settle([hist], () => legend.set([['a']]));
		const table = nonDDL()
			.at(-1)!
			.match(/"(__dplot_preagg_[^"]+)"/)![1];
		const catIs = async (value: string) =>
			expected(`SELECT g, count(*) FROM t WHERE cat = '${value}' GROUP BY g`);

		// The table goes away under the mark: its next read fails.
		await conn.exec!(`DROP TABLE "${table}"`);
		const from = nonDDL().length;
		await settle([hist], () => legend.set([['b']]));

		const after = lastQueriesSince(from);
		expect(after).toHaveLength(2);
		expect(after[0]).toContain(table);
		expect(after[1]).not.toContain('__dplot_preagg_');
		expect(hist.error).toBeNull();
		expect(rowsOf(hist)).toEqual(await catIs('b'));
		expect(warn.mock.calls.some((args) => String(args[0]).includes('preagg read failed'))).toBe(
			true
		);

		// Set aside: later frames go straight to the base table.
		await settle([hist], () => legend.set([['a']]));
		expect(nonDDL().at(-1)).not.toContain('__dplot_preagg_');
		expect(rowsOf(hist)).toEqual(await catIs('a'));

		// A new activation rebuilds the table, and frames read it again.
		await activateToggle(['cat']);
		await settle([hist], () => legend.set([['b']]));
		expect(nonDDL().at(-1)).toContain(table);
		expect(rowsOf(hist)).toEqual(await catIs('b'));
	});

	it('reports the error when the base query fails too', async () => {
		const hist = await mark('hist', { g: column('g'), n: count() });
		await activateToggle(['cat']);
		const legend = group.registerToggle('cat');
		await settle([hist], () => legend.set([['a']]));
		const table = nonDDL()
			.at(-1)!
			.match(/"(__dplot_preagg_[^"]+)"/)![1];

		await conn.exec!(`DROP TABLE "${table}"; ALTER TABLE t RENAME TO t_gone`);
		legend.set([['b']]);
		await vi.waitFor(() => expect(hist.error).not.toBeNull());
		await conn.exec!(`ALTER TABLE t_gone RENAME TO t`);
	});
});
