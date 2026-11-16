import type { BinPadding, BinWindow } from '$lib/types';

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
 * margin of `MARGIN` viewports each side, and moved only when the viewport
 * comes within half a viewport of an edge the data extends past, or outgrows
 * it. Units are the bins' extent units (ms for time, values for numeric); the
 * SQL snaps the ends to the bin grid and clips them to the extent.
 */

/** Viewports of margin on each side of the viewport. */
export const MARGIN = 1;

/**
 * A viewport on the scale, in the bins' units. A time scale's domain is
 * seconds from its origin `t0` (epoch seconds), the form its channels take in
 * the query; time bins count in epoch ms. Numeric: the same units.
 */
export function viewInBinUnits(
	view: readonly [number, number],
	t0: number | null
): [number, number] {
	if (t0 === null) return [view[0], view[1]];
	return [(view[0] + t0) * 1000, (view[1] + t0) * 1000];
}

/** The window for a viewport `[lo, hi]`, in the bins' units (viewInBinUnits). */
export function binWindowFor(view: readonly [number, number]): BinWindow {
	const width = view[1] - view[0];
	return [view[0] - MARGIN * width, view[1] + MARGIN * width];
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

/** The extent a bin spec covers, in its own units. */
export function binExtent(bin: BinPadding): [number, number] {
	if (bin.kind === 'time') return [bin.minMs, bin.maxMs];
	return [bin.min, bin.min + bin.alpha * bin.count];
}
