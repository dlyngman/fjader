/**
 * Integration test: a binned mark's query grouped ONCE by its bin's key
 * (assembleQuery, sharedBinKeys) returns the same rows, to the bit, as the
 * query that groups by every edge. Numeric and time bins as `bin()` resolves
 * them, alone and under the transforms that wrap them, with a filter, a row
 * filter, a series, NULLs in the binned column and a window. Runs against
 * native DuckDB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { avg, column, count, sql, sum } from '@uwdata/mosaic-sql';
import type { ExprNode } from '@uwdata/mosaic-sql';
import { bin } from '$lib/sql/bin';
import { dense, filter, having, normalize, rank, stackY, topN } from '$lib/transforms';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { assembleQuery, buildQueryParts, castNumeric, sharedBinKeys } from './query-builder';
import type { QueryParts } from './query-builder';
import type { BinPadding, BinWindow, MarkConfig, Transform } from '$lib/types';

interface DB {
	run(sql: string): Promise<void>;
	all(sql: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

function openDB(): DB {
	const db = new duckdb.Database(':memory:');
	return {
		run: (q) => new Promise((res, rej) => db.run(q, (e: Error | null) => (e ? rej(e) : res()))),
		all: (q) =>
			new Promise((res, rej) =>
				db.all(q, (e: Error | null, rows: Record<string, unknown>[]) => (e ? rej(e) : res(rows)))
			),
		close: () => new Promise((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
}

// v: 0.37 apart over [-60, 180), with stretches left out (empty bins) and
// every 97th NULL; w a measure; g a series of three; t hourly over 60 days.
const T0 = Date.UTC(2024, 0, 1) / 1000;
const MIN_MS = Date.UTC(2024, 0, 1);
const MAX_MS = MIN_MS + (60 * 24 - 1) * 3600_000;
const SEED_SQL = `
CREATE TABLE d AS
SELECT CASE WHEN i % 97 = 0 THEN NULL ELSE -60 + i * 0.37 END AS v,
       (i * 7) % 13 AS w,
       CAST(i % 3 AS REAL) AS g,
       CASE WHEN i % 89 = 0 THEN NULL ELSE TIMESTAMP '2024-01-01' + INTERVAL (i * 2) HOUR END AS t
FROM range(648) r(i) WHERE (i // 40) % 3 <> 1;
`;

let db: DB;
beforeAll(async () => {
	db = openDB();
	await db.run(SEED_SQL);
});
afterAll(async () => db.close());

const NUM_INFO = { v: { min: -60, max: 179.39 } };
const TIME_INFO = { t: { min: MIN_MS, max: MAX_MS, type: 'date' } };

/** A channel and its padding, as the lifecycle resolves a `bin()`. */
function edge(
	kind: 'number' | 'time',
	offset: number,
	interval = 'day'
): { expr: ExprNode; pad: BinPadding } {
	if (kind === 'number') {
		const node = bin('v', { step: 10, offset });
		return { expr: node.resolve(NUM_INFO, 'linear'), pad: node.padding(NUM_INFO, 'linear')! };
	}
	const node = bin('t', { interval: interval as never, offset });
	const bucket = node.resolve(TIME_INFO, 'time');
	return {
		// As #inlineTimeOffsets rewrites a time channel.
		expr: sql`CAST((epoch(${bucket}) - ${T0}) AS REAL)`,
		pad: node.padding(TIME_INFO, 'time', null, 1, T0)!
	};
}

interface Case {
	kind: 'number' | 'time';
	/** A time bin's unit; a day when left out. */
	interval?: string;
	/** Channel → offset of the bin's edge. */
	edges: Record<string, number>;
	measures: Record<string, ExprNode>;
	series?: boolean;
	transforms?: Transform[];
	filter?: ExprNode[];
	binWindow?: BinWindow | null;
	/** Mark config a transform reads (a stack's band, value and series). */
	config?: Partial<MarkConfig>;
}

/** The mark's parts as the lifecycle builds them, and the SQL of a base read. */
function build(c: Case, keyed: boolean): { sql: string; parts: QueryParts } {
	const select: Record<string, unknown> = {};
	const bins: Record<string, BinPadding> = {};
	for (const [channel, offset] of Object.entries(c.edges)) {
		const { expr, pad } = edge(c.kind, offset, c.interval);
		select[channel] = expr;
		bins[channel] = pad;
	}
	if (c.series) select.fill = column('g');
	Object.assign(select, c.measures);
	const transforms = c.transforms ?? [];
	const compiler = new TransformCompiler(transforms, {
		markType: 'rectY',
		table: 'd',
		...c.config
	} as MarkConfig);
	const parts = buildQueryParts(select, null, compiler.hasSQLTransforms());
	parts.bins = bins;
	if (!keyed) delete parts.groupByChannels;
	const selectDef: Record<string, unknown> = {};
	for (const [channel, expr] of Object.entries(parts.selectDef)) {
		selectDef[channel] = castNumeric(expr, null);
	}
	const query = assembleQuery({
		table: 'd',
		parts: { ...parts, selectDef },
		filter: c.filter ?? [],
		transformCompiler: compiler,
		binWindow: c.binWindow ?? null
	});
	return { sql: query.toString(), parts };
}

/** Rows as comparable text: column order, then every value's float32 bits. */
function bits(rows: Record<string, unknown>[]): string[] {
	const f = new Float32Array(1);
	const u = new Uint32Array(f.buffer);
	return rows
		.map((row) =>
			Object.entries(row)
				.map(([name, value]) => {
					if (typeof value !== 'number') return `${name}=${String(value)}`;
					f[0] = value;
					return `${name}=${u[0].toString(16)}`;
				})
				.join(' ')
		)
		.sort();
}

const HIST = { x1: 0, x2: 1 };
const PATH = { x: 0.5, x1: 0, x2: 1 };
const CASES: [string, Case][] = [
	['a numeric histogram', { kind: 'number', edges: HIST, measures: { y: count() } }],
	['a time histogram', { kind: 'time', edges: HIST, measures: { y: count() } }],
	['a numeric path: centre and edges', { kind: 'number', edges: PATH, measures: { y: avg('w') } }],
	[
		'a monthly path: the centre between its bucket’s edges',
		{ kind: 'time', interval: 'month', edges: PATH, measures: { y: avg('w') } }
	],
	[
		'a monthly path, padded',
		{
			kind: 'time',
			interval: 'month',
			edges: PATH,
			measures: { y: avg('w') },
			transforms: [dense()]
		}
	],
	[
		'numeric, padded',
		{ kind: 'number', edges: HIST, measures: { y: count() }, transforms: [dense()] }
	],
	['time, padded', { kind: 'time', edges: HIST, measures: { y: count() }, transforms: [dense()] }],
	[
		'numeric, padded over a window',
		{
			kind: 'number',
			edges: HIST,
			measures: { y: count() },
			transforms: [dense()],
			binWindow: [0, 75]
		}
	],
	[
		'time, padded over a window',
		{
			kind: 'time',
			edges: HIST,
			measures: { y: count() },
			transforms: [dense()],
			binWindow: [MIN_MS + 5 * 86_400_000, MIN_MS + 30 * 86_400_000]
		}
	],
	[
		'numeric, a series, stacked',
		{
			kind: 'number',
			edges: HIST,
			measures: { y2: sum('w') },
			series: true,
			transforms: [dense(), stackY()],
			config: { x: 'x2', y: 'y2', fill: 'fill' }
		}
	],
	[
		'numeric, a series, the top bins, stacked',
		{
			kind: 'number',
			edges: HIST,
			measures: { y2: sum('w') },
			series: true,
			transforms: [topN(5), stackY()],
			config: { x: 'x2', y: 'y2', fill: 'fill' }
		}
	],
	[
		'numeric, a series, the top bins and Other, stacked',
		{
			kind: 'number',
			edges: HIST,
			measures: { y2: sum('w') },
			series: true,
			transforms: [topN(5, { includeOthers: true }), stackY()],
			config: { x: 'x2', y: 'y2', fill: 'fill' }
		}
	],
	[
		'time, a series, normalized and stacked',
		{
			kind: 'time',
			edges: HIST,
			measures: { y2: sum('w') },
			series: true,
			transforms: [normalize(), stackY()],
			config: { x: 'x2', y: 'y2', fill: 'fill' }
		}
	],
	[
		'numeric, ranked by its measure',
		{
			kind: 'number',
			edges: HIST,
			measures: { y2: count() },
			transforms: [rank({ axis: 'x', channel: 'y2', direction: 'desc' })],
			config: { x: 'x2', y: 'y2' }
		}
	],
	[
		'numeric, with a selection filter',
		{
			kind: 'number',
			edges: HIST,
			measures: { y: count() },
			transforms: [dense()],
			filter: [sql`"w" BETWEEN 2 AND 9`]
		}
	],
	[
		'numeric, with a row filter transform',
		{
			kind: 'number',
			edges: HIST,
			measures: { y: count() },
			transforms: [filter(sql`"w" > 4`), dense()]
		}
	],
	[
		'time, with a row filter transform and a selection filter',
		{
			kind: 'time',
			edges: HIST,
			measures: { y: count() },
			transforms: [filter(sql`"w" > 4`)],
			filter: [sql`"v" < 100`]
		}
	]
];

describe('a bin grouped once by its key', () => {
	for (const [name, c] of CASES) {
		it(`gives the same rows to the bit: ${name}`, async () => {
			const keyed = build(c, true);
			const each = build(c, false);
			expect(sharedBinKeys(keyed.parts)).toHaveLength(1);
			expect(keyed.sql).toContain('"__bin0"');
			expect(each.sql).not.toContain('"__bin0"');
			const [a, b] = await Promise.all([db.all(keyed.sql), db.all(each.sql)]);
			expect(a.length).toBeGreaterThan(0);
			expect(bits(a)).toEqual(bits(b));
		});
	}

	it('puts a month’s centre halfway between its own edges, not 15 days in', async () => {
		const { sql: text } = build(
			{ kind: 'time', interval: 'month', edges: PATH, measures: { y: count() } },
			true
		);
		const rows = (await db.all(text)).filter((row) => !Number.isNaN(row.x as number));
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) {
			expect(row.x).toBeCloseTo(((row.x1 as number) + (row.x2 as number)) / 2, 0);
		}
		// January has 31 days: its centre is 15.5 days in.
		const january = rows.find((row) => row.x1 === 0)!;
		expect(january.x).toBe(15.5 * 86_400);
	});

	it('groups by the key alone, and by the series beside it', () => {
		const { sql: text } = build(
			{ kind: 'number', edges: HIST, measures: { y: count() }, series: true },
			true
		);
		const groupBy = text.slice(text.indexOf('GROUP BY'));
		expect(groupBy.match(/floor\(/g)).toHaveLength(1);
		expect(groupBy).toContain('"g"');
	});

	it('leaves a bin with one channel as it is', () => {
		const one = build({ kind: 'number', edges: { x: 0 }, measures: { y: count() } }, true);
		expect(sharedBinKeys(one.parts)).toHaveLength(0);
		expect(one.sql).not.toContain('__bin');
	});

	it('keeps the one-level form for a bin with an edge dropped for NULLs', () => {
		const keyed = build({ kind: 'number', edges: PATH, measures: { y: count() } }, true);
		expect(sharedBinKeys(keyed.parts)).toHaveLength(1);
		expect(sharedBinKeys({ ...keyed.parts, nullDrops: [{ channel: 'x', nullId: null }] })).toEqual(
			[]
		);
	});

	it('keeps the one-level form under having(), which names aggregates over the rows', () => {
		const text = build(
			{
				kind: 'number',
				edges: HIST,
				measures: { y: count() },
				transforms: [having(sql`count(*) > 3`)]
			},
			true
		).sql;
		expect(text).not.toContain('__bin');
	});
});
