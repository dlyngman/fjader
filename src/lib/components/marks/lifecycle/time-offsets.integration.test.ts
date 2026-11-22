/**
 * A time axis draws each channel from its own column.
 *
 * On a time scale every datetime channel is sent to the GPU as seconds from the
 * scale's origin t0. The scale is keyed by one column (the first to claim it),
 * but the channels drawn on it may read others: a range's x1 and x2, or a second
 * mark on another date column in the same chart. Each must stay its own column,
 * offset from the shared t0.
 *
 * Runs the mark's assembled query in native DuckDB and reads the offsets back.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import duckdb from 'duckdb';
import { MarkLifecycleV2 } from './MarkLifecycleV2.svelte';
import { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
import { setInitialContinuousDomains } from './domain-registration';

interface DB {
	run(sql: string): Promise<void>;
	all(sql: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

function openDB(): DB {
	const db = new duckdb.Database(':memory:');
	return {
		run: (sql: string) =>
			new Promise((res, rej) => db.run(sql, (e: Error | null) => (e ? rej(e) : res()))),
		all: (sql: string) =>
			new Promise((res, rej) =>
				db.all(sql, (e: Error | null, rows: Record<string, unknown>[]) => (e ? rej(e) : res(rows)))
			),
		close: () => new Promise((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
}

// Two events: each ends a day and an hour after it starts.
const ROWS = [
	{ started: '2024-01-01 00:00:00', ended: '2024-01-02 01:00:00', v: 1 },
	{ started: '2024-01-03 00:00:00', ended: '2024-01-04 01:00:00', v: 2 }
];
const DAY = 86_400;
const HOUR = 3_600;
const T0 = new Date('2024-01-01T00:00:00Z');

let db: DB;

beforeAll(async () => {
	db = openDB();
	await db.run(`SET TimeZone = 'UTC'`);
	await db.run(`CREATE TABLE events (started TIMESTAMP, ended TIMESTAMP, v DOUBLE)`);
	for (const r of ROWS) {
		await db.run(`INSERT INTO events VALUES ('${r.started}', '${r.ended}', ${r.v})`);
	}
});

afterAll(async () => {
	await db?.close();
});

/** A chart whose x is a time scale keyed by `started`, with t0 at its earliest start. */
function timeChart() {
	const x = new TimeScaleState('started', [0, 1], 'time', [1e-6, 1e6], {}, null);
	x.addDatetimeExtent([T0, new Date('2024-01-04T01:00:00Z')], 'extent', { instant: true });
	return {
		chartId: 'chart-1',
		xScaleState: x,
		yScaleState: new LinearScaleState('v'),
		facetBandScale: null,
		scaleTypes: { x: 'time', y: 'linear' },
		config: {},
		registerScaleType: () => {},
		unregisterScaleType: () => {},
		placeExtent: () => true,
		placeColumnExtent: () => true
	};
}

/** The rows a mark's query returns, its time channels as offsets from t0, by v. */
async function rowsOf(chart: ReturnType<typeof timeChart>, select: Record<string, string>) {
	const lifecycle = new MarkLifecycleV2(
		{
			markType: 'dot',
			supportedScaleTypes: { x: ['time'], y: ['linear'] },
			scaleRequirements: {
				x: { type: 'time', priority: SCALE_PRIORITIES.MANDATE },
				y: { type: 'linear', priority: SCALE_PRIORITIES.PREFER }
			},
			table: 'events',
			transforms: [],
			select
		} as never,
		{} as never,
		{ onIdentityReset: () => () => {} } as never,
		chart as never,
		'dot-1',
		{ selection: { predicate: () => null } } as never
	);
	// What the setup's domain and schema queries would do once they land.
	lifecycle.setupComplete = true;

	const query = lifecycle.buildQuery();
	lifecycle.destroy();
	expect(query).not.toBeNull();

	const rows = await db.all(query!);
	return rows.sort((a, b) => Number(a.y) - Number(b.y));
}

describe('a time axis draws each channel from its own column', () => {
	it('a range mark: x1 from its start, x2 from its end', async () => {
		const rows = await rowsOf(timeChart(), { x1: 'started', x2: 'ended', y: 'v' });

		expect(rows.map((r) => [r.x1, r.x2])).toEqual([
			[0, DAY + HOUR],
			[2 * DAY, 3 * DAY + HOUR]
		]);
	});

	it('a second mark on another date column, in a chart keyed by the first', async () => {
		const chart = timeChart();
		const starts = await rowsOf(chart, { x: 'started', y: 'v' });
		const ends = await rowsOf(chart, { x: 'ended', y: 'v' });

		expect(starts.map((r) => r.x)).toEqual([0, 2 * DAY]);
		expect(ends.map((r) => r.x)).toEqual([DAY + HOUR, 3 * DAY + HOUR]);
	});
});

describe('a time axis spans every channel drawn on it', () => {
	it('a range reaches its latest end, not only its latest start', async () => {
		// Field stats as #fetchFieldStats reads them: raw MIN/MAX, as epoch ms.
		const [row] = await db.all(
			`SELECT min(started) AS s0, max(started) AS s1, min(ended) AS e0, max(ended) AS e1 FROM events`
		);
		const stats = {
			started: { column: 'started', min: Number(row.s0), max: Number(row.s1) },
			ended: { column: 'ended', min: Number(row.e0), max: Number(row.e1) }
		};
		const x = new TimeScaleState('started', [0, 1], 'time', [1e-6, 1e6], {}, null);

		setInitialContinuousDomains(
			stats,
			{ x, y: null },
			{ x1: 'started', x2: 'ended', y: 'v' },
			'time',
			'linear',
			'rect-1',
			() => true,
			() => true
		);

		expect(x.t0).toEqual(T0);
		// The latest end is 3 days and an hour after t0; the latest start only 2 days.
		expect(x.effectiveExtent[0]).toBeLessThanOrEqual(0);
		expect(x.effectiveExtent[1]).toBeGreaterThanOrEqual(3 * DAY + HOUR);
	});
});
