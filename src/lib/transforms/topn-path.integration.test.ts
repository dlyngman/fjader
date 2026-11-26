/**
 * Integration test: topN on a line or an area keeps the top n SERIES, whole,
 * and the padding leaves the others out (MarkConfig.rankedSeries).
 *
 * A line's series is in `stroke`, which topN's bar path never looked at, so it
 * ranked rows and kept n points; an area's band is its x bins, so it kept n
 * bins. And dense() padded every series of the dim back in at zero: lines along
 * the baseline for every series left out. Each case runs the real assembly
 * (buildQueryParts + assembleQuery + TransformCompiler) against native DuckDB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { column, count, eq, literal, sql, type ExprNode } from '@uwdata/mosaic-sql';
import { topN, stackY, withDenseCategories, TransformCompiler, RANK_COLUMN } from './index';
import {
	buildQueryParts,
	assembleQuery,
	castReal,
	pathGapChannels
} from '$lib/components/marks/lifecycle/query-builder';
import type { BinPadding, MarkConfig, Transform } from '$lib/types';

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

// Seven carriers over 24 hours: carrier c has 70 - 10c flights, so they rank
// 0 > 1 > ... > 6. Carriers 0 to 2 fly only on day 0 and 3 to 6 only on day 1,
// so a brush on day 1 makes 3, 4 and 5 the top three. Carrier 6 has no flights
// in hours 12 and later. `ties`: carriers 0 and 1 have the same total.
const BINS = 24;
const CARRIERS = 7;
const SEED_SQL = `
CREATE TABLE f AS
SELECT
	((i * 7) % 24) + 0.5 AS hour,
	c::INT AS c,
	CASE WHEN c < 3 THEN 0 ELSE 1 END AS day
FROM range(${CARRIERS}) cs(c), range(70) r(i)
WHERE i < 70 - 10 * c AND NOT (c = 6 AND ((i * 7) % 24) >= 12);
CREATE TABLE c_dim AS SELECT DISTINCT c AS value, c::INT AS id FROM f;
CREATE TABLE ties AS
SELECT (i % 24) + 0.5 AS hour, c::INT AS c
FROM range(3) cs(c), range(60) r(i)
WHERE i < CASE WHEN c = 2 THEN 30 ELSE 60 END;
CREATE TABLE t_dim AS SELECT DISTINCT c AS value, c::INT AS id FROM ties;
`;

let db: DB;
beforeAll(async () => {
	db = openDB();
	await db.run(SEED_SQL);
});
afterAll(async () => db.close());

const HOUR_BIN = sql`CAST(floor("hour") AS REAL)`;
const HOUR_BINS: Record<string, BinPadding> = {
	x: { kind: 'number', source: '"hour"', min: 0, alpha: 1, count: BINS, offset: 0 }
};

interface Case {
	/** The series channel: a line's `stroke`, an area's `fill`. */
	series: 'stroke' | 'fill';
	transforms: Transform[];
	filter?: ExprNode;
	table?: string;
	dim?: string;
	size?: number;
	/** A stacked area: no path gaps, a SQL stack. */
	stacked?: boolean;
}

/** A path mark's query, assembled as the lifecycle does, and its rows. */
async function run(c: Case): Promise<{ sql: string; rows: Record<string, number>[] }> {
	const select: Record<string, ExprNode> = {
		x: HOUR_BIN,
		y: castReal(count()),
		[c.series]: castReal(column('c'))
	};
	const transforms = withDenseCategories(c.transforms);
	const parts = buildQueryParts(select, { seriesChannel: c.series, dimensionChannel: 'x' }, true);
	parts.bins = HOUR_BINS;
	const topped = c.transforms.some((t) => t.type === 'topN');
	const config = {
		markType: c.series === 'fill' ? 'areay' : 'line',
		table: c.table ?? 'f',
		x: 'x',
		y: 'y',
		...(c.series === 'fill' ? { fill: 'fill' } : {}),
		identity: {
			[c.series]: { dim: c.dim ?? 'c_dim', size: c.size ?? CARRIERS, positional: false }
		},
		// As MarkLifecycleV2.#pathPadding and #rankedSeries state them.
		...(c.stacked ? {} : { gaps: pathGapChannels(select), absentSeriesGap: true }),
		rankedSeries: topped ? c.series : null,
		path: true
	} as MarkConfig;
	const compiler = new TransformCompiler(transforms, config);
	const query = assembleQuery({
		table: c.table ?? 'f',
		parts,
		transformCompiler: compiler,
		filter: c.filter ? [c.filter] : []
	});
	const text = String(query);
	const rows = (await db.all(text)).map((row) =>
		Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]))
	);
	return { sql: text, rows };
}

/** Per series id: its rows, and how many are drawn (a number) or gaps (NaN). */
function bySeries(rows: Record<string, number>[], series: string, value = 'y') {
	const out = new Map<number, { rows: number; drawn: number; gaps: number; total: number }>();
	for (const row of rows) {
		const s = row[series];
		const e = out.get(s) ?? { rows: 0, drawn: 0, gaps: 0, total: 0 };
		e.rows++;
		if (Number.isNaN(row[value])) e.gaps++;
		else {
			e.drawn++;
			e.total += row[value];
		}
		out.set(s, e);
	}
	return out;
}

/** The series ids drawn (any bin with a value), sorted. */
const drawnSeries = (rows: Record<string, number>[], series: string, value = 'y') =>
	[...bySeries(rows, series, value)]
		.filter(([, e]) => e.drawn > 0)
		.map(([s]) => s)
		.sort((a, b) => a - b);

describe('topN on a line (series in stroke)', () => {
	it('keeps the top three series, whole: every bin of each, at its real count', async () => {
		const { rows } = await run({ series: 'stroke', transforms: [topN(3)] });
		expect(drawnSeries(rows, 'stroke')).toEqual([0, 1, 2]);
		const per = bySeries(rows, 'stroke');
		// Whole lines: 70, 60 and 50 flights over their bins, a point in every bin.
		expect([0, 1, 2].map((s) => per.get(s)!.total)).toEqual([70, 60, 50]);
		for (const s of [0, 1, 2]) expect(per.get(s)!.drawn).toBe(BINS);
	});

	it('pads the series left out as gaps, not lines at zero; every series keeps its slots', async () => {
		const { rows } = await run({ series: 'stroke', transforms: [topN(3)] });
		const per = bySeries(rows, 'stroke');
		for (const s of [3, 4, 5, 6, -1])
			expect(per.get(s)).toEqual({ rows: BINS, drawn: 0, gaps: BINS, total: 0 });
		// One row per bin per series, as without the topN: the layout a line
		// travels on does not change when the top three do.
		expect(rows).toHaveLength(BINS * (CARRIERS + 1));
	});

	it('under a brush the top three are the brushed ones', async () => {
		const { rows } = await run({
			series: 'stroke',
			transforms: [topN(3)],
			filter: eq(column('day'), literal(1))
		});
		expect(drawnSeries(rows, 'stroke')).toEqual([3, 4, 5]);
		expect(rows).toHaveLength(BINS * (CARRIERS + 1));
	});

	it('a series kept but with no data in a bin is zero there: a count of none', async () => {
		const { rows } = await run({
			series: 'stroke',
			transforms: [topN(4)],
			filter: eq(column('day'), literal(1))
		});
		// Carrier 6 is fourth on day 1, with no flights from hour 12.
		const six = rows.filter((row) => row.stroke === 6);
		expect(six.every((row) => !Number.isNaN(row.y))).toBe(true);
		expect(six.filter((row) => row.x >= 12).every((row) => row.y === 0)).toBe(true);
	});

	it('publishes no rank column: a path has no band axis to order', async () => {
		const { rows, sql: text } = await run({ series: 'stroke', transforms: [topN(3)] });
		expect(RANK_COLUMN in rows[0]).toBe(false);
		expect(text).not.toContain(RANK_COLUMN);
	});

	it('a tie breaks on the series id, so every read keeps the same series', async () => {
		const { rows } = await run({
			series: 'stroke',
			transforms: [topN(1)],
			table: 'ties',
			dim: 't_dim',
			size: 3
		});
		expect(drawnSeries(rows, 'stroke')).toEqual([0]);
	});
});

describe('a line without topN', () => {
	it('keeps a series a brush emptied as a line at zero, as before', async () => {
		const { rows } = await run({
			series: 'stroke',
			transforms: [],
			filter: eq(column('day'), literal(1))
		});
		const per = bySeries(rows, 'stroke');
		for (const s of [0, 1, 2])
			expect(per.get(s)).toEqual({ rows: BINS, drawn: BINS, gaps: 0, total: 0 });
	});
});

describe('topN on an area (series in fill)', () => {
	it('keeps the top three series, not the top three bins', async () => {
		const { rows } = await run({ series: 'fill', transforms: [topN(3)] });
		expect(drawnSeries(rows, 'fill')).toEqual([0, 1, 2]);
		const per = bySeries(rows, 'fill');
		for (const s of [0, 1, 2]) expect(per.get(s)!.drawn).toBe(BINS);
	});

	it('stacked: ranks the series before the stack, and the stack sums the kept ones only', async () => {
		const { rows } = await run({
			series: 'fill',
			transforms: [topN(3), stackY()],
			stacked: true
		});
		expect(drawnSeries(rows, 'fill', 'y1')).toEqual([0, 1, 2]);
		// The left-out series are NaN through the stack, edges included: no band,
		// and nothing spread into the bands stacked above them.
		for (const row of rows.filter((r) => ![0, 1, 2].includes(r.fill))) {
			expect(Number.isNaN(row.y0) && Number.isNaN(row.y1)).toBe(true);
		}
		// Per bin, the top edge is the sum of the kept series' counts.
		const counts = await db.all(
			`SELECT floor(hour)::INT AS b, count(*)::INT AS n FROM f WHERE c < 3 GROUP BY b`
		);
		const top = new Map<number, number>();
		for (const row of rows) {
			if (Number.isNaN(row.y1)) continue;
			top.set(row.x, Math.max(top.get(row.x) ?? 0, row.y1));
		}
		for (const { b, n } of counts) expect(top.get(Number(b))).toBe(Number(n));
	});
});

describe('topN on a path it cannot rank', () => {
	it('a line or area with no series keeps every row: no n points, no n spikes', async () => {
		const select = { x: HOUR_BIN, y: castReal(count()) };
		const config = { markType: 'areay', table: 'f', x: 'x', y: 'y', path: true } as MarkConfig;
		const assemble = (transforms: Transform[]) => {
			const parts = buildQueryParts(select, null, transforms.length > 0);
			parts.bins = HOUR_BINS;
			const compiler = new TransformCompiler(withDenseCategories(transforms), config);
			return String(assembleQuery({ table: 'f', parts, transformCompiler: compiler }));
		};
		const withTop = await db.all(assemble([topN(5)]));
		const without = await db.all(assemble([]));
		expect(withTop.length).toBe(without.length);
		expect(withTop.length).toBe(BINS);

		// And it cuts nothing, so the mark keeps its window's source filter.
		expect(new TransformCompiler([topN(5)], config).hasCategoryReducingTransforms()).toBe(false);
	});

	it('includeOthers on a path ranking its series reserves no Other bucket', () => {
		const compiler = new TransformCompiler([topN(3, { includeOthers: true })], {
			markType: 'line',
			table: 'f',
			x: 'x',
			y: 'y',
			rankedSeries: 'stroke',
			path: true
		} as MarkConfig);
		expect(compiler.hasSyntheticOtherBucket()).toBe(false);
		expect(compiler.otherBy()).toBeNull();
		// A bar's topN keeps its Other.
		const bar = new TransformCompiler([topN(3, { includeOthers: true })], {
			markType: 'bary',
			table: 'f'
		} as MarkConfig);
		expect(bar.hasSyntheticOtherBucket()).toBe(true);
	});
});

describe('a topN mark and preagg', () => {
	it('its preagg table holds no padding rows, so its reads rank and pad as a base read does', () => {
		const compiler = new TransformCompiler(withDenseCategories([topN(3)]), {
			markType: 'line',
			table: 'f',
			x: 'x',
			y: 'y',
			rankedSeries: 'stroke'
		} as MarkConfig);
		expect(
			compiler.padRows(['x', 'y', 'stroke'], {
				groupKeys: ['x', 'stroke'],
				bins: HOUR_BINS,
				identity: { stroke: { dim: 'c_dim', size: CARRIERS, positional: false } }
			})
		).toBeNull();
	});
});
