/**
 * What `fitDomain` fits, defined once for both of the ways it is computed.
 *
 * A fit is the extent of the fitted axis's channels over the rows the driving
 * axis's window keeps. It is computed either by the database, as a MIN/MAX
 * over the mark's query (`fitSelect` + `fitWindowWhere`), or, for a binned
 * mark, from the result the mark already holds (`windowedFit`). The channels,
 * the window predicate and the baseline are defined here so the two cannot
 * drift: the SQL builder and the JS pass read the same definitions.
 *
 * One difference is left on purpose: a NaN value (an empty bin of an `avg`)
 * is skipped by the JS pass, while DuckDB orders NaN above every number, so
 * its MAX of a channel holding one is NaN and the caller drops that channel
 * entirely. The JS answer is the one meant.
 */

import { cast, column, max, min, sql, type ExprValue, type FilterExpr } from '@uwdata/mosaic-sql';
import type { BinLayout } from './bin-layout';

/**
 * The channels whose extent is the fit, for `axis`: the axis and its two
 * edges as the mark selects them, plus the stacked edges a transform adds
 * (`y0`/`y1` from stackY).
 */
export function fitChannels(
	axis: 'x' | 'y',
	selected: Record<string, unknown>,
	transformChannels: readonly string[]
): string[] {
	const channels = [axis, `${axis}1`, `${axis}2`].filter((c) => c in selected);
	if (transformChannels.length > 0) {
		for (const ch of [`${axis}0`, `${axis}1`]) {
			if (transformChannels.includes(ch) && !channels.includes(ch)) channels.push(ch);
		}
	}
	return channels;
}

/**
 * The driving axis's window edges: a row is in the window when its upper edge
 * reaches the window's start and its lower edge does not pass its end, so a
 * bin the window cuts counts. Without both edges, the one channel is the
 * position.
 */
export function windowEdges(
	drivingChannels: readonly string[]
): { lower: string; upper: string } | { position: string } | null {
	const lower = drivingChannels.find((c) => c.endsWith('1'));
	const upper = drivingChannels.find((c) => c.endsWith('2'));
	if (lower && upper) return { lower, upper };
	return drivingChannels[0] ? { position: drivingChannels[0] } : null;
}

/** MIN/MAX of each fitted channel, as `min_<ch>`/`max_<ch>`. */
export function fitSelect(fitted: readonly string[]): Record<string, ExprValue> {
	const select: Record<string, ExprValue> = {};
	for (const ch of fitted) {
		select[`min_${ch}`] = min(column(ch));
		select[`max_${ch}`] = max(column(ch));
	}
	return select;
}

/**
 * The window predicate in SQL; the same test `windowedFit` makes.
 *
 * The channels are REAL (castNumeric) and the window's ends are doubles.
 * Compared as they are, DuckDB casts the number down to REAL, so a window
 * end within one float32 step of an edge rounds onto it: at time offsets of
 * 3e7 s, a window starting 1 s after a bin's end still kept that bin. The
 * column cast up to DOUBLE is exact, and is the comparison JS makes.
 */
export function fitWindowWhere(
	drivingChannels: readonly string[],
	[lo, hi]: readonly [number, number]
): FilterExpr | undefined {
	const edges = windowEdges(drivingChannels);
	if (!edges) return undefined;
	const exact = (ch: string) => cast(column(ch), 'DOUBLE');
	if ('lower' in edges) {
		return sql`${exact(edges.upper)} >= ${lo} AND ${exact(edges.lower)} <= ${hi}`;
	}
	return sql`${exact(edges.position)} BETWEEN ${lo} AND ${hi}`;
}

/** The extent from a `fitSelect` row: every finite min and max, across channels. */
export function extentFromFitRow(row: Record<string, unknown>): [number, number] | null {
	let lo = Infinity;
	let hi = -Infinity;
	for (const key in row) {
		const v = row[key];
		if (typeof v !== 'number' || !isFinite(v)) continue;
		if (key.startsWith('min_') && v < lo) lo = v;
		if (key.startsWith('max_') && v > hi) hi = v;
	}
	return lo < hi ? [lo, hi] : null;
}

/** The fit as registered: widened to include 0 when the mark draws from a zero baseline. */
export function withBaseline(
	[lo, hi]: readonly [number, number],
	zeroBaseline: boolean
): [number, number] {
	return zeroBaseline ? [Math.min(0, lo), Math.max(0, hi)] : [lo, hi];
}

/**
 * The fit from a binned result: the extent of `fitted` over the bins the
 * window keeps (`upper >= lo && lower <= hi`, as `fitWindowWhere`), or over
 * every bin with no window. Null when nothing in the window has a finite
 * extent, as the SQL fit's empty answer.
 *
 * The edges are ascending at stride `series`, and every facet repeats the
 * first facet's bins (`binLayout`), so the window's first and last bins are
 * found once, by binary search over the first facet, and only their runs are
 * read in each: O(log B + F × visible bins × S) values. No allocation.
 */
export function windowedFit(
	lower: ArrayLike<number>,
	upper: ArrayLike<number>,
	layout: BinLayout,
	fitted: readonly ArrayLike<number>[],
	window: readonly [number, number] | null
): [number, number] | null {
	const { series, bins, facets } = layout;
	const perFacet = bins * series;
	let first = 0;
	let last = bins - 1;
	if (window) {
		// First bin whose upper edge reaches the window's start.
		let a = 0;
		let b = bins;
		while (a < b) {
			const m = (a + b) >> 1;
			if (upper[m * series] >= window[0]) b = m;
			else a = m + 1;
		}
		first = a;
		// Last bin whose lower edge does not pass the window's end.
		a = -1;
		b = bins - 1;
		while (a < b) {
			const m = (a + b + 1) >> 1;
			if (lower[m * series] <= window[1]) a = m;
			else b = m - 1;
		}
		last = a;
	}
	let lo = Infinity;
	let hi = -Infinity;
	for (let f = 0; f < facets; f++) {
		const base = f * perFacet;
		const end = base + (last + 1) * series;
		for (let c = 0; c < fitted.length; c++) {
			const values = fitted[c];
			for (let r = base + first * series; r < end; r++) {
				const v = values[r];
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
		}
	}
	return lo < hi ? [lo, hi] : null;
}
