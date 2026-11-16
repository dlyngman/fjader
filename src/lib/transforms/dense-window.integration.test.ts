/**
 * Integration test: a binned mark's padding over a WINDOW (MarkConfig.binWindow)
 * returns exactly the whole extent's padded rows inside it — real and padded
 * bins alike, the same edges to the bit — and nothing else. Numeric and time
 * bins, a base read and a padded table's read, and the row limit counted over
 * the window. Runs the SQL `dense()` builds against native DuckDB.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import duckdb from 'duckdb';
import { Query, count, sql } from '@uwdata/mosaic-sql';
import type { SelectQuery } from '@uwdata/mosaic-sql';
import { dense } from './index';
import type { BinPadding, BinWindow, MarkConfig } from '$lib/types';

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

// num: x in [0, 1000), with every other run of 50 left out, so whole stretches
// of bins are empty and only padding can return them.
// ts: one row per hour over 60 days from 2024-01-01, a gap on days 20..29.
const T0 = Date.UTC(2024, 0, 1) / 1000;
const SEED_SQL = `
CREATE TABLE num AS SELECT i AS x FROM range(1000) r(i) WHERE (i // 50) % 2 = 0;
CREATE TABLE ts AS
SELECT TIMESTAMP '2024-01-01' + INTERVAL (i) HOUR AS t FROM range(60 * 24) r(i)
WHERE i // 24 NOT BETWEEN 20 AND 29;
`;

let db: DB;
beforeAll(async () => {
	db = openDB();
	await db.run(SEED_SQL);
});
afterAll(async () => db.close());

const ALIASES = ['x1', 'x2', 'y'];

// --- Numeric: alpha 10 over [0, 1000), 100 bins.
const NUM: Record<string, BinPadding> = {
	x1: { kind: 'number', source: '"x"', min: 0, alpha: 10, count: 100, offset: 0 },
	x2: { kind: 'number', source: '"x"', min: 0, alpha: 10, count: 100, offset: 1 }
};
const numEdge = (offset: number) => `CAST(10 * (floor("x" / 10) + ${offset}) AS REAL)`;
const numQuery = () =>
	Query.from('num')
		.select({ x1: sql`${numEdge(0)}`, x2: sql`${numEdge(1)}`, y: count() })
		.groupby('x1', 'x2') as SelectQuery;

// --- Time: daily buckets, edges as seconds from T0 (the form bin() draws).
const DAY = 'INTERVAL 1 day';
const MIN_MS = Date.UTC(2024, 0, 1);
const MAX_MS = MIN_MS + (60 * 24 - 1) * 3600_000;
const TIME: Record<string, BinPadding> = {
	x1: {
		kind: 'time',
		source: '"t"',
		interval: DAY,
		minMs: MIN_MS,
		maxMs: MAX_MS,
		t0: T0,
		count: 62,
		offset: 0
	},
	x2: {
		kind: 'time',
		source: '"t"',
		interval: DAY,
		minMs: MIN_MS,
		maxMs: MAX_MS,
		t0: T0,
		count: 62,
		offset: 1
	}
};
const timeEdge = (offset: number) =>
	`CAST((epoch(time_bucket(${DAY}, "t") + (${DAY}) * ${offset}) - ${T0}) AS REAL)`;
const timeQuery = () =>
	Query.from('ts')
		.select({ x1: sql`${timeEdge(0)}`, x2: sql`${timeEdge(1)}`, y: count() })
		.groupby('x1', 'x2') as SelectQuery;

const config = (bins: Record<string, BinPadding>, extra: Partial<MarkConfig> = {}) =>
	({ markType: 'recty', table: 't', groupKeys: ['x1', 'x2'], bins, ...extra }) as MarkConfig;

/** Rows of a query, ordered by bin. */
async function rows(q: SelectQuery | string): Promise<Record<string, number>[]> {
	const out = await db.all(`SELECT * FROM (${q}) ORDER BY x1`);
	return out as Record<string, number>[];
}

const padded = (bins: Record<string, BinPadding>, q: SelectQuery, window: BinWindow | null) =>
	dense().apply(q, config(bins, { binWindow: window })) as SelectQuery;

describe('dense() over a window', () => {
	it('numeric: the window’s bins, real and padded, as the whole extent has them', async () => {
		const whole = await rows(padded(NUM, numQuery(), null));
		expect(whole).toHaveLength(100);
		// [205, 431]: bins 20 (200..210) through 43 (430..440).
		const windowed = await rows(padded(NUM, numQuery(), [205, 431]));
		expect(windowed).toEqual(whole.filter((r) => r.x1 >= 200 && r.x1 <= 430));
		expect(windowed).toHaveLength(24);
		// 250..300 and 350..400 hold no data: padding returns those bins as zeros.
		expect(windowed.filter((r) => Number(r.y) === 0).map((r) => r.x1)).toEqual([
			250, 260, 270, 280, 290, 350, 360, 370, 380, 390
		]);
	});

	it('numeric: a window past either end is clipped to the bins that exist', async () => {
		const whole = await rows(padded(NUM, numQuery(), null));
		expect(await rows(padded(NUM, numQuery(), [-500, 35]))).toEqual(whole.slice(0, 4));
		expect(await rows(padded(NUM, numQuery(), [975, 5000]))).toEqual(whole.slice(97));
	});

	it('time: the window’s daily buckets, edges to the bit, the gap padded', async () => {
		const whole = await rows(padded(TIME, timeQuery(), null));
		expect(whole).toHaveLength(60);
		// Days 15.5 to 33.2: buckets of days 15 through 33.
		const day = 86_400_000;
		const windowed = await rows(
			padded(TIME, timeQuery(), [MIN_MS + 15.5 * day, MIN_MS + 33.2 * day])
		);
		const sec = (d: number) => d * 86_400;
		expect(windowed).toEqual(whole.filter((r) => r.x1 >= sec(15) && r.x1 <= sec(33)));
		expect(windowed).toHaveLength(19);
		expect(windowed.filter((r) => Number(r.y) === 0)).toHaveLength(10);
	});

	it('a padded table’s read keeps the window’s rows only', async () => {
		await db.run(`CREATE OR REPLACE TABLE padded_num AS ${padded(NUM, numQuery(), null)}`);
		const read = Query.from('padded_num').select(ALIASES) as SelectQuery;
		const windowed = dense().apply(
			read,
			config(NUM, { padded: true, binWindow: [205, 431] })
		) as SelectQuery;
		expect(await rows(windowed)).toEqual(await rows(padded(NUM, numQuery(), [205, 431])));

		await db.run(`CREATE OR REPLACE TABLE padded_ts AS ${padded(TIME, timeQuery(), null)}`);
		const day = 86_400_000;
		const window: BinWindow = [MIN_MS + 15.5 * day, MIN_MS + 33.2 * day];
		const readTs = Query.from('padded_ts').select(ALIASES) as SelectQuery;
		const windowedTs = dense().apply(readTs, config(TIME, { padded: true, binWindow: window }));
		expect(await rows(windowedTs as SelectQuery)).toEqual(
			await rows(padded(TIME, timeQuery(), window))
		);
	});

	it('a padded table’s read without a window is left as it is', () => {
		const read = Query.from('padded_num').select(ALIASES) as SelectQuery;
		expect(dense().apply(read, config(NUM, { padded: true }))).toBe(read);
	});

	it('counts the limit over the window: deep in a long extent it pads', () => {
		const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
		const many: Record<string, BinPadding> = {
			x1: { kind: 'number', source: '"x"', min: 0, alpha: 1, count: 50_000, offset: 0 },
			x2: { kind: 'number', source: '"x"', min: 0, alpha: 1, count: 50_000, offset: 1 }
		};
		expect(dense().alignment!(ALIASES, config(many))).toBeNull();
		expect(dense().alignment!(ALIASES, config(many, { binWindow: [1000, 1300] }))).toEqual(['x1']);
		spy.mockRestore();
	});
});
