/**
 * Integration test: the rows a path mark's query RETURNS are laid out as the
 * query declares them (row-layout.ts).
 *
 * A line or area joins each point to the next of its series, so it depends on
 * the order of its rows, which only the database can show: `dense()` pads a
 * binned mark to one row per bin per series and orders it bin first, and a
 * renderer that read those rows as series-first drew nothing, with no query
 * failing and nothing reported. Each case runs the real assembly
 * (buildQueryParts + assembleQuery + TransformCompiler) against native DuckDB
 * and checks the result against the layout the lifecycle would declare for it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { avg, column, count, sql, type ExprNode } from '@uwdata/mosaic-sql';
import { stackY, withDenseCategories, TransformCompiler } from '$lib/transforms';
import { buildQueryParts, assembleQuery, castReal, pathGapChannels } from './query-builder';
import { rowLayoutOf, type RowLayout } from './row-layout';
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

// Flights by hour of day (24 bins), distance band (4 series) and carrier (3
// facets), with holes: 'long' flies only in the morning, and one carrier has no
// 'short' flights at all. Only padding returns those (bin, series) pairs.
const BINS = 24;
const BANDS = ['long', 'medium', 'short', 'very long'];
const CARRIERS = ['AA', 'DL', 'UA'];
const SEED_SQL = `
CREATE TABLE flights AS
SELECT
	(i % 240) / 10.0 AS hour,
	(['long', 'medium', 'short', 'very long'])[1 + (i % 4)] AS band,
	(['AA', 'DL', 'UA'])[1 + (i % 3)] AS carrier
FROM range(6000) r(i)
WHERE NOT ((i % 4) = 0 AND (i % 240) >= 120)
  AND NOT ((i % 4) = 2 AND (i % 3) = 1);
CREATE TABLE band_dim AS
	SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id
	FROM (SELECT DISTINCT band AS value FROM flights);
CREATE TABLE carrier_dim AS
	SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id
	FROM (SELECT DISTINCT carrier AS value FROM flights);
CREATE VIEW flights_v AS
	SELECT f.*, b.id AS band_idx, c.id AS carrier_idx
	FROM flights f JOIN band_dim b ON f.band = b.value JOIN carrier_dim c ON f.carrier = c.value;
-- The same flights with the morning's 'medium' ones of no known band: their id is
-- -1, the absent series, here with data.
CREATE VIEW flights_unknown_v AS
	SELECT * REPLACE (CASE WHEN band = 'medium' AND hour < 6 THEN -1 ELSE band_idx END AS band_idx)
	FROM flights_v;
`;

let db: DB;
beforeAll(async () => {
	db = openDB();
	await db.run(SEED_SQL);
});
afterAll(async () => db.close());

/** The hour bin's lower edge, as `bin('hour')` draws it. */
const HOUR_BIN = sql`CAST(floor("hour") AS REAL)`;
const HOUR_BINS: Record<string, BinPadding> = {
	x: { kind: 'number', source: '"hour"', min: 0, alpha: 1, count: BINS, offset: 0 }
};
/** What a path mark asks for: its series, then its dimension. */
const PATH_ORDER = { seriesChannel: 'fill', dimensionChannel: 'x' };

interface Case {
	select: Record<string, ExprNode>;
	transforms: Transform[];
	bins?: Record<string, BinPadding>;
	identity?: MarkConfig['identity'];
	series?: boolean;
	/** The table the mark reads; the flights' view by default. */
	table?: string;
	/** A path mark's padding facts (MarkConfig.gaps, absentSeriesGap). */
	path?: boolean;
}

/** A path mark's query run as the lifecycle assembles it, and the layout it declares. */
async function run(c: Case): Promise<{
	sql: string;
	rows: Record<string, number>[];
	layout: RowLayout;
}> {
	const transforms = withDenseCategories(c.transforms);
	const hasSQL = transforms.some((t) => t.stage === 'sql');
	const parts = buildQueryParts(c.select, c.series === false ? null : PATH_ORDER, hasSQL);
	parts.bins = c.bins ?? null;
	// The channel names the stack reads its band, value and series from.
	const table = c.table ?? 'flights_v';
	const config = {
		markType: 'areay',
		table,
		x: 'x',
		y: 'y2',
		fill: 'fill',
		identity: c.identity,
		// As the lifecycle states them for an unstacked path mark.
		...(c.path ? { gaps: pathGapChannels(c.select), absentSeriesGap: true } : {})
	} as MarkConfig;
	const compiler = new TransformCompiler(transforms, config);
	const query = assembleQuery({ table, parts, transformCompiler: compiler });
	const text = String(query);
	const rows = (await db.all(text)).map((row) =>
		Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]))
	);
	const channels = Object.keys(parts.selectDef);
	const aligned = compiler.alignment(channels, {
		groupKeys: parts.groupKeys,
		bins: parts.bins ?? null,
		binWindow: null
	});
	const column = (channel: string) =>
		rows.length > 0 && channel in rows[0] ? rows.map((row) => row[channel]) : null;
	return {
		sql: text,
		rows,
		layout: rowLayoutOf(aligned, rows.length, column, channels.includes('__facet'))
	};
}

/** Every row of a grid sits where the layout says: bin b, series s, facet f at `(f·B + b)·S + s`. */
function expectGridOrder(
	rows: Record<string, number>[],
	layout: Extract<RowLayout, { kind: 'grid' }>,
	series: number[],
	facets: number[] | null
) {
	const { bins: B, series: S, facets: F } = layout;
	expect(rows).toHaveLength(F * B * S);
	for (let f = 0; f < F; f++) {
		for (let b = 0; b < B; b++) {
			for (let s = 0; s < S; s++) {
				const row = rows[(f * B + b) * S + s];
				expect(row.x).toBe(b);
				if (S > 1) expect(row.fill).toBe(series[s]);
				if (facets) expect(row.__facet).toBe(facets[f]);
			}
		}
	}
}

const BAND_IDENTITY = { fill: { dim: 'band_dim', size: BANDS.length, positional: false } };
// The series ids as the padding crosses them in: -1 (a value the dim does not
// hold yet) sorts first, then the dim's own.
const SERIES_IDS = [-1, 0, 1, 2, 3];

describe('a path mark over a plain column', () => {
	it('returns runs: nothing pads it, so each series is contiguous', async () => {
		const { rows, layout } = await run({
			select: {
				x: castReal(column('hour')),
				y: castReal(column('hour')),
				fill: castReal(column('band_idx'))
			},
			transforms: []
		});
		expect(layout).toEqual({ kind: 'runs' });
		const seriesOf = rows.map((row) => row.fill);
		expect(seriesOf).toEqual([...seriesOf].sort((a, b) => a - b));
		for (let i = 1; i < rows.length; i++) {
			if (rows[i].fill === rows[i - 1].fill)
				expect(rows[i].x).toBeGreaterThanOrEqual(rows[i - 1].x);
		}
	});
});

describe('a path mark over a binned axis', () => {
	it('without a series: a grid of one row per bin', async () => {
		const { rows, layout } = await run({
			select: { x: HOUR_BIN, y: castReal(count()) },
			transforms: [],
			bins: HOUR_BINS,
			series: false
		});
		expect(layout).toEqual({ kind: 'grid', facets: 1, bins: BINS, series: 1 });
		expectGridOrder(rows, layout as Extract<RowLayout, { kind: 'grid' }>, [], null);
	});

	it('with a series (an unstacked line): a grid, bin first, every pair padded', async () => {
		const {
			rows,
			layout,
			sql: text
		} = await run({
			select: { x: HOUR_BIN, y: castReal(count()), fill: castReal(column('band_idx')) },
			transforms: [],
			bins: HOUR_BINS,
			identity: BAND_IDENTITY
		});
		// The order that drew nothing when it was read as runs.
		expect(text).toMatch(/ORDER BY "x", "fill"$/);
		expect(layout).toEqual({ kind: 'grid', facets: 1, bins: BINS, series: SERIES_IDS.length });
		expectGridOrder(rows, layout as Extract<RowLayout, { kind: 'grid' }>, SERIES_IDS, null);
		// 'long' (id 0) has no flights after noon: those rows exist, at zero.
		const longAfternoon = rows.filter((row) => row.fill === 0 && row.x >= 12);
		expect(longAfternoon).toHaveLength(12);
		expect(longAfternoon.every((row) => row.y === 0)).toBe(true);
	});

	it('with a series and a stack (a stacked area): the same grid, stacked within each bin', async () => {
		const { rows, layout } = await run({
			select: {
				x: HOUR_BIN,
				y: castReal(count()),
				y2: castReal(count()),
				fill: castReal(column('band_idx'))
			},
			transforms: [stackY()],
			bins: HOUR_BINS,
			identity: BAND_IDENTITY
		});
		expect(layout).toEqual({ kind: 'grid', facets: 1, bins: BINS, series: SERIES_IDS.length });
		const grid = layout as Extract<RowLayout, { kind: 'grid' }>;
		expectGridOrder(rows, grid, SERIES_IDS, null);
		for (let b = 0; b < BINS; b++) {
			for (let s = 1; s < grid.series; s++) {
				const below = rows[b * grid.series + s - 1];
				const row = rows[b * grid.series + s];
				expect(row.y0).toBe(below.y1);
			}
		}
	});

	it('faceted: one grid per cell, the cells in order', async () => {
		const { rows, layout } = await run({
			select: {
				x: HOUR_BIN,
				y: castReal(count()),
				y2: castReal(count()),
				fill: castReal(column('band_idx')),
				__facet: castReal(column('carrier_idx'))
			},
			transforms: [stackY()],
			bins: HOUR_BINS,
			identity: {
				...BAND_IDENTITY,
				__facet: { dim: 'carrier_dim', size: CARRIERS.length, positional: false }
			}
		});
		expect(layout.kind).toBe('grid');
		const grid = layout as Extract<RowLayout, { kind: 'grid' }>;
		expect(grid.bins).toBe(BINS);
		expect(grid.series).toBe(SERIES_IDS.length);
		const facetIds = [...new Set(rows.map((row) => row.__facet))];
		expect(grid.facets).toBe(facetIds.length);
		expectGridOrder(rows, grid, SERIES_IDS, facetIds);
	});
});

describe('rows that come back in another order', () => {
	it('are refused, not read as a grid: the query above, re-sorted series first', async () => {
		const { sql: text } = await run({
			select: { x: HOUR_BIN, y: castReal(count()), fill: castReal(column('band_idx')) },
			transforms: [],
			bins: HOUR_BINS,
			identity: BAND_IDENTITY
		});
		const resorted = (await db.all(`SELECT * FROM (${text}) ORDER BY "fill", "x"`)).map((row) =>
			Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]))
		);
		const layout = rowLayoutOf(['x', 'fill'], resorted.length, (channel) =>
			resorted.map((row) => row[channel])
		);
		expect(layout.kind).toBe('refused');
	});
});

describe('what a padded row holds on a path', () => {
	const series = SERIES_IDS.length;
	const ofSeries = (rows: Record<string, number>[], id: number) =>
		rows.filter((row) => row.fill === id);

	it('a count stays 0 where a series has no flights, and the layout is unchanged', async () => {
		const { rows, layout } = await run({
			select: { x: HOUR_BIN, y: castReal(count()), fill: castReal(column('band_idx')) },
			transforms: [],
			bins: HOUR_BINS,
			identity: BAND_IDENTITY,
			path: true
		});
		expect(layout).toEqual({ kind: 'grid', facets: 1, bins: BINS, series });
		// 'long' (id 0) has no flights after noon: a count of none is 0, drawn.
		const longAfternoon = ofSeries(rows, 0).filter((row) => row.x >= 12);
		expect(longAfternoon).toHaveLength(12);
		expect(longAfternoon.every((row) => row.y === 0)).toBe(true);
	});

	it('the absent series is left out when it is empty: NaN in every bin, still a row', async () => {
		const { rows } = await run({
			select: { x: HOUR_BIN, y: castReal(count()), fill: castReal(column('band_idx')) },
			transforms: [],
			bins: HOUR_BINS,
			identity: BAND_IDENTITY,
			path: true
		});
		const absent = ofSeries(rows, -1);
		expect(absent).toHaveLength(BINS);
		expect(absent.every((row) => Number.isNaN(row.y))).toBe(true);
		// No other series is touched.
		expect(rows.filter((row) => row.fill !== -1).every((row) => !Number.isNaN(row.y))).toBe(true);
	});

	it('the absent series keeps its data when it has some, zeros included', async () => {
		const { rows } = await run({
			select: { x: HOUR_BIN, y: castReal(count()), fill: castReal(column('band_idx')) },
			transforms: [],
			bins: HOUR_BINS,
			identity: BAND_IDENTITY,
			table: 'flights_unknown_v',
			path: true
		});
		const absent = ofSeries(rows, -1);
		expect(absent).toHaveLength(BINS);
		expect(absent.filter((row) => row.x < 6).every((row) => row.y > 0)).toBe(true);
		expect(absent.filter((row) => row.x >= 6).every((row) => row.y === 0)).toBe(true);
	});

	it('a mean is a gap where a series has no flights, not a point at zero', async () => {
		const { rows, layout } = await run({
			select: {
				x: HOUR_BIN,
				y: castReal(avg(column('hour'))),
				fill: castReal(column('band_idx'))
			},
			transforms: [],
			bins: HOUR_BINS,
			identity: BAND_IDENTITY,
			path: true
		});
		expect(layout).toEqual({ kind: 'grid', facets: 1, bins: BINS, series });
		const long = ofSeries(rows, 0);
		expect(long.filter((row) => row.x >= 12).every((row) => Number.isNaN(row.y))).toBe(true);
		// Where it flies, the mean of the hours in bin b lies in [b, b + 1).
		for (const row of long.filter((r) => r.x < 12)) {
			expect(row.y).toBeGreaterThanOrEqual(row.x);
			expect(row.y).toBeLessThan(row.x + 1);
		}
		// The empty absent series is all gaps already.
		expect(ofSeries(rows, -1).every((row) => Number.isNaN(row.y))).toBe(true);
	});

	it('a count coloured by a mean keeps its padded points: y 0, and a colour that is not NaN', async () => {
		const { rows } = await run({
			select: {
				x: HOUR_BIN,
				y: castReal(count()),
				stroke: castReal(avg(column('hour'))),
				fill: castReal(column('band_idx'))
			},
			transforms: [],
			bins: HOUR_BINS,
			identity: BAND_IDENTITY,
			path: true
		});
		const longAfternoon = ofSeries(rows, 0).filter((row) => row.x >= 12);
		expect(longAfternoon).toHaveLength(12);
		expect(longAfternoon.every((row) => row.y === 0 && row.stroke === 0)).toBe(true);
		// The empty absent series is left out by its position alone.
		const absent = ofSeries(rows, -1);
		expect(absent.every((row) => Number.isNaN(row.y) && row.stroke === 0)).toBe(true);
	});

	it('without the path facts (a bar, a stack) a padded row is 0, as before', async () => {
		const { rows } = await run({
			select: {
				x: HOUR_BIN,
				y: castReal(avg(column('hour'))),
				fill: castReal(column('band_idx'))
			},
			transforms: [],
			bins: HOUR_BINS,
			identity: BAND_IDENTITY
		});
		expect(rows.every((row) => !Number.isNaN(row.y))).toBe(true);
		expect(ofSeries(rows, -1).every((row) => row.y === 0)).toBe(true);
	});

	it('faceted, the absent series is judged per cell', async () => {
		// 'medium' before 06:00 is the absent series' only data, and the carrier
		// with id 1 has no such flights at all: its cell leaves the series out,
		// the others draw it.
		const { rows } = await run({
			select: {
				x: HOUR_BIN,
				y: castReal(count()),
				fill: castReal(column('band_idx')),
				__facet: castReal(column('carrier_idx'))
			},
			transforms: [],
			bins: HOUR_BINS,
			identity: {
				...BAND_IDENTITY,
				__facet: { dim: 'carrier_dim', size: CARRIERS.length, positional: false }
			},
			table: 'flights_unknown_v',
			path: true
		});
		const cell = (facet: number) => rows.filter((row) => row.__facet === facet && row.fill === -1);
		const empty = [0, 1, 2].filter((f) => cell(f).every((row) => Number.isNaN(row.y)));
		const drawn = [0, 1, 2].filter((f) => cell(f).some((row) => row.y > 0));
		expect(empty.length + drawn.length).toBe(3);
		expect(drawn.length).toBeGreaterThan(0);
		for (const f of drawn) expect(cell(f).every((row) => !Number.isNaN(row.y))).toBe(true);
	});
});
