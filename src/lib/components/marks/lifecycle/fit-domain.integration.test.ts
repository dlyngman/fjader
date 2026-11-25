/**
 * Integration test: a binned mark's fit from its result (`windowedFit`) equals
 * the SQL fit (`fitSelect` + `fitWindowWhere`) over the same rows, in native
 * DuckDB.
 *
 * The rows are a dense stacked histogram as the mark receives them: REAL
 * columns (castNumeric), ordered by facet, bin, series. Windows cover bin
 * edges exactly, cuts through a bin, the extent's ends and beyond, and no
 * window at all.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { Query } from '@uwdata/mosaic-sql';
import { binLayout } from './bin-layout';
import {
	extentFromFitRow,
	fitChannels,
	fitSelect,
	fitWindowWhere,
	windowedFit,
	withBaseline
} from './fit-domain';

interface DB {
	all(sql: string): Promise<Record<string, unknown>[]>;
	run(sql: string): Promise<void>;
	close(): Promise<void>;
}

function openDB(): DB {
	const db = new duckdb.Database(':memory:');
	return {
		run: (sql) => new Promise((res, rej) => db.run(sql, (e: Error | null) => (e ? rej(e) : res()))),
		all: (sql) =>
			new Promise((res, rej) =>
				db.all(sql, (e: Error | null, rows: Record<string, unknown>[]) => (e ? rej(e) : res(rows)))
			),
		close: () => new Promise((res) => db.close(() => res()))
	};
}

// Bin edges as a time histogram draws them: seconds from t0, at the magnitude
// of a 2-year extent (~3e7 s), where float32 steps are 2 s and the edges round
// like the real ones. 120 bins of 6.25 days.
const BINS = 120;
const WIDTH = 6.25 * 86400;
const SERIES = 4;
const FACETS = 2;

let db: DB;
let columns: Record<string, Float32Array>;
let rows = 0;

beforeAll(async () => {
	db = openDB();
	await db.run(`
		CREATE TABLE res AS
		WITH grid AS (
			SELECT f, b, s, (hash(f, b, s) % 1000)::DOUBLE / 10 AS v
			FROM range(${FACETS}) t1(f), range(${BINS}) t2(b), range(${SERIES}) t3(s)
		)
		SELECT
			CAST(f AS REAL) AS __facet,
			CAST(1.0e6 + b * ${WIDTH} AS REAL) AS x1,
			CAST(1.0e6 + (b + 1) * ${WIDTH} AS REAL) AS x2,
			CAST(s AS REAL) AS fill,
			CAST(v AS REAL) AS y,
			CAST(SUM(v) OVER (PARTITION BY f, b ORDER BY s) - v AS REAL) AS y0,
			CAST(SUM(v) OVER (PARTITION BY f, b ORDER BY s) AS REAL) AS y1
		FROM grid
	`);
	const out = await db.all(`SELECT * FROM res ORDER BY __facet, x1, fill`);
	rows = out.length;
	columns = {};
	for (const name of ['x1', 'x2', 'y', 'y0', 'y1']) {
		columns[name] = Float32Array.from(out.map((r) => r[name] as number));
	}
});

afterAll(async () => {
	await db?.close();
});

const select = { x1: true, x2: true, y: true };
const fitted = fitChannels('y', select, ['y0', 'y1']);
const driving = fitChannels('x', select, ['y0', 'y1']);

async function sqlFit(window: [number, number] | null): Promise<[number, number] | null> {
	const q = Query.from('res').select(fitSelect(fitted));
	if (window) q.where(fitWindowWhere(driving, window)!);
	const [row] = await db.all(q.toString());
	return row ? extentFromFitRow(row) : null;
}

function jsFit(window: [number, number] | null): [number, number] | null {
	const layout = binLayout(columns.x1, rows)!;
	return windowedFit(
		columns.x1,
		columns.x2,
		layout,
		fitted.map((c) => columns[c]),
		window
	);
}

describe('a NaN value (a gap) is skipped by both fits', () => {
	it('the SQL fit ignores it, as the JS pass does, where a plain MAX would be NaN', async () => {
		// A line of means with gaps: every fourth bin has no value in y.
		await db.run(
			`CREATE OR REPLACE TABLE gaps AS
			 SELECT * REPLACE (CASE WHEN (x1 / ${WIDTH})::INT % 4 = 0 THEN 'NaN'::REAL ELSE y END AS y)
			 FROM res`
		);
		const plain = await db.all(`SELECT MAX(y) AS m FROM gaps`);
		expect(plain[0].m).toBeNaN();

		const [row] = await db.all(
			Query.from('gaps')
				.select(fitSelect(['y']))
				.toString()
		);
		const sqlExtent = extentFromFitRow(row);
		const [reference] = await db.all(
			`SELECT MIN(y) AS lo, MAX(y) AS hi FROM gaps WHERE NOT isnan(y)`
		);
		expect(sqlExtent).toEqual([reference.lo, reference.hi]);
	});

	it('a channel that is all gaps gives no extent, not NaN', async () => {
		await db.run(`CREATE OR REPLACE TABLE allgaps AS SELECT 'NaN'::REAL AS y FROM range(8)`);
		const [row] = await db.all(
			Query.from('allgaps')
				.select(fitSelect(['y']))
				.toString()
		);
		expect(extentFromFitRow(row)).toBeNull();
	});
});

describe('windowedFit against the SQL fit', () => {
	it('reads the rows as the dense layout', () => {
		expect(fitted).toEqual(['y', 'y0', 'y1']);
		expect(driving).toEqual(['x1', 'x2']);
		expect(binLayout(columns.x1, rows)).toEqual({ series: SERIES, bins: BINS, facets: FACETS });
	});

	it('agrees with no window', async () => {
		expect(jsFit(null)).toEqual(await sqlFit(null));
	});

	it('agrees on windows at edges, through bins, at the ends and beyond', async () => {
		const edge = (b: number) => columns.x1[b * SERIES];
		const end = columns.x2[rows - 1];
		const windows: [number, number][] = [
			[edge(10), edge(20)], // exactly on edges: both neighbours touch
			[edge(10) + WIDTH / 3, edge(20) - WIDTH / 3], // cutting through two bins
			[edge(0) - 5 * WIDTH, edge(3)], // before the extent into it
			[edge(BINS - 3), end + 5 * WIDTH], // into the end and past it
			[edge(57) + 1, edge(57) + 2], // inside one bin
			[end + WIDTH, end + 2 * WIDTH], // past the extent: empty
			[edge(0) - 2 * WIDTH, edge(0) - WIDTH] // before it: empty
		];
		for (let i = 0; i < 40; i++) {
			const a = edge(0) + ((i * 7919) % (BINS * WIDTH));
			windows.push([a, a + ((i * 104729) % (20 * WIDTH)) + 1]);
		}
		for (const w of windows) {
			expect(jsFit(w), `window ${w}`).toEqual(await sqlFit(w));
		}
	});

	it('applies the zero baseline the same way to both', async () => {
		const w: [number, number] = [columns.x1[40 * SERIES], columns.x1[45 * SERIES]];
		const js = jsFit(w)!;
		const db = (await sqlFit(w))!;
		expect(withBaseline(js, true)).toEqual(withBaseline(db, true));
		expect(withBaseline(js, true)[0]).toBe(0);
	});
});
