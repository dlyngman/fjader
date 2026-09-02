/**
 * Integration test: verify base-path CTE and preagg-path CTE produce
 * identical results for windowed aggregates with skewed group sizes.
 *
 * Uses native DuckDB (not duckdb-wasm) for fast in-process execution.
 * This catches the AVG-of-AVGs vs pooled-mean class of bugs — if the
 * two paths ever diverge, this test fails.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { column, avg, frameRows, preceding, following } from '@uwdata/mosaic-sql';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import {
	buildQueryParts,
	assembleQuery,
	splitWindowSelect
} from '$lib/components/marks/lifecycle/query-builder';

// ---------------------------------------------------------------------------
// DuckDB helper — promise wrapper around callback API
// ---------------------------------------------------------------------------

interface DB {
	run(sql: string): Promise<void>;
	all(sql: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

function openDB(): DB {
	const db = new duckdb.Database(':memory:');
	return {
		run: (sql: string) => new Promise((res, rej) => db.run(sql, (e: Error | null) => (e ? rej(e) : res()))),
		all: (sql: string) =>
			new Promise((res, rej) => db.all(sql, (e: Error | null, rows: Record<string, unknown>[]) => (e ? rej(e) : res(rows)))),
		close: () => new Promise((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
}

// ---------------------------------------------------------------------------
// Test fixture: skewed group sizes
// ---------------------------------------------------------------------------
//
// 4 dates, 2 series, intentionally non-uniform row counts:
//
//   date  | series | rows | mean(value)
//   ------+--------+------+-----------
//   day1  | A      | 1000 | ~10
//   day2  | A      |   10 | ~100
//   day3  | A      |  500 | ~50
//   day4  | A      |    5 | ~200
//   day1  | B      |  100 | ~30
//   day2  | B      |  100 | ~30
//   day3  | B      |  100 | ~30
//   day4  | B      |  100 | ~30
//
// Series A has wildly skewed sizes → AVG-of-means ≠ pooled mean.
// Series B is uniform → both statistics coincide (control group).
//
// With a centered window of ±1 (3-row frame), the expected smoothed
// value at day2/series-A is:
//   AVG-of-means: (mean(day1) + mean(day2) + mean(day3)) / 3
//   Pooled mean:  (sum(day1) + sum(day2) + sum(day3)) / (count(day1) + count(day2) + count(day3))
//
// These differ because day1 has 1000 rows vs day2's 10.

const SEED_SQL = `
CREATE TABLE skewed AS
SELECT * FROM (
  -- Series A: skewed group sizes
  SELECT 1 AS date, 'A' AS series, 10.0 AS value FROM generate_series(1, 1000)
  UNION ALL
  SELECT 2, 'A', 100.0 FROM generate_series(1, 10)
  UNION ALL
  SELECT 3, 'A', 50.0 FROM generate_series(1, 500)
  UNION ALL
  SELECT 4, 'A', 200.0 FROM generate_series(1, 5)
  UNION ALL
  -- Series B: uniform group sizes (control)
  SELECT 1, 'B', 30.0 FROM generate_series(1, 100)
  UNION ALL
  SELECT 2, 'B', 30.0 FROM generate_series(1, 100)
  UNION ALL
  SELECT 3, 'B', 30.0 FROM generate_series(1, 100)
  UNION ALL
  SELECT 4, 'B', 30.0 FROM generate_series(1, 100)
)
`;

// ---------------------------------------------------------------------------
// SQL for the two paths
// ---------------------------------------------------------------------------

// Base path: inner CTE groups raw rows, outer applies window.
// This is what #assembleSQL produces for a pure-window selectDef.
const BASE_CTE_SQL = `
WITH __window_cte AS (
  SELECT "date" AS x, "series" AS stroke, AVG("value") AS y
  FROM skewed
  GROUP BY "date", "series"
)
SELECT x, stroke, AVG(y) OVER (PARTITION BY stroke ORDER BY x ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS y
FROM __window_cte
ORDER BY stroke, x
`;

// Preagg path: cube stores SUM + COUNT partials, inner CTE recombines,
// outer applies window. The cube here has no bin dimension (full data).
const PREAGG_CTE_SQL = `
WITH __cube AS (
  SELECT "date", "series", SUM("value") AS __ps0, COUNT("value") AS __ps1
  FROM skewed
  GROUP BY "date", "series"
),
__preagg_cte AS (
  SELECT "date" AS x, "series" AS stroke,
         (SUM("__ps0") / COALESCE(SUM("__ps1"), 1)) AS y
  FROM __cube
  GROUP BY "date", "series"
)
SELECT x, stroke, AVG(y) OVER (PARTITION BY stroke ORDER BY x ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS y
FROM __preagg_cte
ORDER BY stroke, x
`;

// Hand-computed expected values (AVG-of-per-group-means, ±1 window):
//
// Series A means: day1=10, day2=100, day3=50, day4=200
//   day1: avg(10, 100)         = 55
//   day2: avg(10, 100, 50)     = 53.333...
//   day3: avg(100, 50, 200)    = 116.666...
//   day4: avg(50, 200)         = 125
//
// Series B means: all 30
//   all days: 30

const EXPECTED = [
	{ x: 1, stroke: 'A', y: 55 },
	{ x: 2, stroke: 'A', y: 160 / 3 }, // 53.333...
	{ x: 3, stroke: 'A', y: 350 / 3 }, // 116.666...
	{ x: 4, stroke: 'A', y: 125 },
	{ x: 1, stroke: 'B', y: 30 },
	{ x: 2, stroke: 'B', y: 30 },
	{ x: 3, stroke: 'B', y: 30 },
	{ x: 4, stroke: 'B', y: 30 }
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('window CTE correctness (skewed group sizes)', () => {
	let db: DB;

	beforeAll(async () => {
		db = openDB();
		await db.run(SEED_SQL);
	});

	afterAll(async () => {
		await db.close();
	});

	it('base path produces expected AVG-of-means values', async () => {
		const rows = await db.all(BASE_CTE_SQL);
		expect(rows).toHaveLength(EXPECTED.length);
		for (let i = 0; i < rows.length; i++) {
			expect(rows[i].x).toBe(EXPECTED[i].x);
			expect(rows[i].stroke).toBe(EXPECTED[i].stroke);
			expect(rows[i].y).toBeCloseTo(EXPECTED[i].y, 8);
		}
	});

	it('preagg path produces expected AVG-of-means values', async () => {
		const rows = await db.all(PREAGG_CTE_SQL);
		expect(rows).toHaveLength(EXPECTED.length);
		for (let i = 0; i < rows.length; i++) {
			expect(rows[i].x).toBe(EXPECTED[i].x);
			expect(rows[i].stroke).toBe(EXPECTED[i].stroke);
			expect(rows[i].y).toBeCloseTo(EXPECTED[i].y, 8);
		}
	});

	it('both paths produce identical results', async () => {
		const baseRows = await db.all(BASE_CTE_SQL);
		const preaggRows = await db.all(PREAGG_CTE_SQL);
		expect(baseRows).toHaveLength(preaggRows.length);
		for (let i = 0; i < baseRows.length; i++) {
			expect(baseRows[i].x).toBe(preaggRows[i].x);
			expect(baseRows[i].stroke).toBe(preaggRows[i].stroke);
			expect(baseRows[i].y).toBeCloseTo(preaggRows[i].y as number, 10);
		}
	});

	it('engine-assembled base path (splitWindowSelect + assembleQuery) matches expected', async () => {
		// The same shape MarkLifecycleV2 registers for a smooth overlay:
		// dims as column refs, window aggregate on y, passthrough map for both dims.
		const selectDef = {
			x: column('date'),
			stroke: column('series'),
			y: avg('value')
				.partitionby('series')
				.orderby('date')
				.frame(frameRows([preceding(1), following(1)]))
		};
		const passthrough = new Map([
			['x', 'date'],
			['stroke', 'series']
		]);
		const parts = buildQueryParts(
			selectDef,
			{ seriesChannel: 'stroke', dimensionChannel: 'x' },
			false,
			passthrough
		);
		const split = splitWindowSelect(selectDef, passthrough, null);
		const q = assembleQuery({
			table: 'skewed',
			parts: {
				...parts,
				selectDef: split.innerSelect,
				nonAggregateGroupBy: split.innerGroupBy,
				hasAggregates: true
			},
			transformCompiler: new TransformCompiler([]),
			window: { channels: split.windowChannels, cteName: '__window_cte' }
		});

		const rows = await db.all(q.toString());
		expect(rows).toHaveLength(EXPECTED.length);
		for (let i = 0; i < rows.length; i++) {
			expect(rows[i].x).toBe(EXPECTED[i].x);
			expect(rows[i].stroke).toBe(EXPECTED[i].stroke);
			// Aggregates are CAST to REAL (float32) on this path
			expect(rows[i].y).toBeCloseTo(EXPECTED[i].y, 4);
		}
	});

	it('AVG-of-means differs from pooled mean for skewed series A', async () => {
		// Pooled mean at day2/A: (1000*10 + 10*100 + 500*50) / (1000+10+500)
		//                       = (10000 + 1000 + 25000) / 1510
		//                       = 36000 / 1510 ≈ 23.84
		// AVG-of-means at day2/A: (10 + 100 + 50) / 3 ≈ 53.33
		// These must differ — confirms we're testing something meaningful.
		const pooledDay2A = 36000 / 1510; // ≈ 23.84
		const avgOfMeansDay2A = 160 / 3; // ≈ 53.33

		expect(Math.abs(pooledDay2A - avgOfMeansDay2A)).toBeGreaterThan(20);

		const rows = await db.all(BASE_CTE_SQL);
		const day2A = rows.find((r) => r.x === 2 && r.stroke === 'A');
		expect(day2A!.y).toBeCloseTo(avgOfMeansDay2A, 8);
		// NOT the pooled mean:
		expect(Math.abs((day2A!.y as number) - pooledDay2A)).toBeGreaterThan(20);
	});
});
