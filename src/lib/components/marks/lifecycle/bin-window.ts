import type { BinPadding, BinWindow } from '$lib/types';
import { intervalWidthMs, REBIN_RATIO } from '$lib/sql/bin';

/**
 * A binned mark's window: the bins it pads and queries, around the viewport.
 *
 * Padding the bins of the field's whole extent grows with zoom depth, not with
 * the screen: deep in a long extent it passes the dense row limit and the mark
 * snaps. Padding a window bounded by the viewport keeps it to about
 * (1 + 2·margin) × the bins on screen, which the bin step already ties to the
 * plot's width.
 *
 * The window moves rarely, so a pan inside it keeps the rows (and morphs on
 * filters), and the query cache sees few distinct windows: it is placed with a
 * margin of `MARGIN` viewports each side, snapped outward to the bin grid, and
 * moved only when the viewport comes within half a viewport of an edge the
 * data extends past, or outgrows it. With 1.5 viewports of margin, a steady
 * pan re-centres it about once per viewport travelled. Units are the bins' extent units (ms for time, values for numeric); the
 * SQL snaps the ends to the bin grid and clips them to the extent.
 */

/** Viewports of margin on each side of the viewport. */
export const MARGIN = 1.5;

/**
 * A viewport on the scale, in the bins' units. A time scale's domain is
 * seconds from its origin `t0` (epoch seconds), the form its channels take in
 * the query; time bins count in epoch ms. Numeric: the same units.
 */
export function viewInBinUnits(
	view: readonly [number, number],
	t0: number | null,
	/** Written and returned: a frame's check allocates nothing. */
	out: [number, number] = [0, 0]
): [number, number] {
	if (t0 === null) {
		out[0] = view[0];
		out[1] = view[1];
	} else {
		out[0] = (view[0] + t0) * 1000;
		out[1] = (view[1] + t0) * 1000;
	}
	return out;
}

/**
 * The window for a viewport `[lo, hi]`, in the bins' units (viewInBinUnits),
 * snapped outward to `bin`'s grid when given: two windows over the same bins
 * are then the same window, so the SQL is the same (a query cache hit) and no
 * move is seen where the rows did not change. Numeric by index; time by the
 * step's nominal width from the extent's start, which the SQL snaps exactly
 * (months and years are not a fixed width).
 */
export function binWindowFor(view: readonly [number, number], bin?: BinPadding | null): BinWindow {
	const width = view[1] - view[0];
	const lo = view[0] - MARGIN * width;
	const hi = view[1] + MARGIN * width;
	if (!bin) return [lo, hi];
	const [origin, step] =
		bin.kind === 'number' ? [bin.min, bin.alpha] : [bin.minMs, intervalWidthMs(bin.interval)];
	if (!step || !(step > 0)) return [lo, hi];
	return [
		origin + Math.floor((lo - origin) / step) * step,
		origin + Math.ceil((hi - origin) / step) * step
	];
}

/**
 * Whether the window no longer serves the viewport: the viewport wider than
 * its margin allows (a zoom out), or within half a viewport of an edge on a
 * side where the data goes on (`extent`; an edge past the data's end has
 * nothing more to fetch). No window is the whole extent, which serves any
 * viewport: a mark takes its first window at a rebin, not here.
 */
export function binWindowNeedsMove(
	window: BinWindow | null | undefined,
	view: readonly [number, number],
	extent: readonly [number, number] | null
): boolean {
	if (!window) return false;
	const width = view[1] - view[0];
	if (!(width > 0)) return false;
	if (window[1] - window[0] < view[1] - view[0] + width) return true;
	const half = width / 2;
	const moreLeft = !extent || window[0] > extent[0];
	const moreRight = !extent || window[1] < extent[1];
	if (moreLeft && view[0] - window[0] < half) return true;
	if (moreRight && window[1] - view[1] < half) return true;
	return false;
}

/** Whether `[lo, hi]` lies inside the window (none: the whole extent, so yes). */
export function insideBinWindow(
	window: BinWindow | null | undefined,
	range: readonly [number, number]
): boolean {
	return !window || (range[0] >= window[0] && range[1] <= window[1]);
}

/**
 * Whether the window for a viewport `[lo, hi]` (in the bins' units) would hold
 * every bin of `bin`'s extent: then it pads the same bins as no window. Before
 * snapping, which only widens it. Allocates nothing: asked on every frame.
 */
export function windowCoversExtent(view: readonly [number, number], bin: BinPadding): boolean {
	const width = view[1] - view[0];
	const lo = bin.kind === 'time' ? bin.minMs : bin.min;
	const hi = bin.kind === 'time' ? bin.maxMs : bin.min + bin.alpha * bin.count;
	return view[0] - MARGIN * width <= lo && view[1] + MARGIN * width >= hi;
}

/** The extent a bin spec covers, in its own units. */
export function binExtent(bin: BinPadding): [number, number] {
	if (bin.kind === 'time') return [bin.minMs, bin.maxMs];
	return [bin.min, bin.min + bin.alpha * bin.count];
}

/**
 * At most how many bins the window pads, for bins that number `count` across the
 * field's extent and are resolved at rebin `level`: what a path mark's bin cap
 * counts (MarkLifecycleV2.#maxBins), so that bins at the cap never make the
 * padding refuse. An upper bound on what `dense()` counts for any window a view
 * of that level is given (binWindowFor, then the padding's windowBinCount):
 *
 * - The widest view of a level: levels round to the nearest (rebinLevel), so a
 *   view of level L ≥ 1 is at most REBIN_RATIO^(0.5 − L) of the extent. A view
 *   of level 0 or less can be as wide as the extent or wider.
 * - The window: (1 + 2·MARGIN) views, clipped to the extent, so never more
 *   than the extent's bins.
 * - Snapped outward to the bin grid: a bin more on each side, and one for a
 *   float's rounding. Time bins are counted by the extent's estimate scaled to
 *   the window, plus the two buckets an end can straddle, from a width snapped
 *   by the nominal bucket width; with at least 9 buckets, 6 more cover it.
 *
 * The window moves keep this: a move places it around the view as it is, at
 * the bins in effect, and the bins are re-planned at every level change.
 */
export function windowPaddedBins(count: number, level: number, temporal: boolean): number {
	if (level <= 0) return count;
	if (temporal && count < 9) return count;
	const views = 1 + 2 * MARGIN;
	const share = Math.min(1, views * REBIN_RATIO ** (0.5 - level));
	return Math.min(count, Math.ceil(count * share) + (temporal ? 6 : 3));
}
