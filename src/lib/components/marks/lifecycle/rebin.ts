/**
 * Telling a rebin result from any other: by the bin spec it was computed from.
 *
 * A binned mark's query parts carry `bins`, the spec each bin channel resolves
 * to (`AutoBinNode.padding`: interval or alpha, count, origin, the field's
 * extent), set whether or not `dense()` padded the rows. A result is stamped
 * with the parts its own query used (`MarkHandle.resultParts`), so comparing
 * the spec of consecutive results tells a rebin from a filter result, which
 * changes rows and never the spec. Exact for automatic steps, a user's `step`,
 * whole-unit intervals and months, where comparing rows was not.
 *
 * The spec holds more than the step: the field's extent and, for time, the
 * scale's origin. A data reload or a new time origin therefore also reads as
 * a rebin, and the value axis re-registers (and may snap). That is intended:
 * after either, the old domain describes nothing current.
 */

import type { BinPadding, BinWindow } from '$lib/types';

/**
 * Whether a rebin result's value axis TWEENS to its new unit (inside the
 * scale's `discrete()`), the usual case: every consumer of the scale follows
 * the render domain, static marks glide and morphing ones ride the tween.
 *
 * Not for a catch-up result (a chart back in view after the shared axis was
 * zoomed while it was off screen): its bars land at once (`land: 'all'`), so
 * the axis must land with them. A tween under landed bars would leave them at
 * half or double height for its length: the duck, on every return to view.
 * Its instant registration then snaps, as any change nobody watched does.
 *
 * Not for an axis the user zoomed: a rebin does not override that.
 */
export function rebinTweens(userDriven: boolean, catchUp: boolean): boolean {
	return !userDriven && !catchUp;
}

/** `bins` as one comparable string; null without any (no bin channel, or none resolved yet). */
export function binSpecKey(bins: Record<string, BinPadding> | null | undefined): string | null {
	return bins ? JSON.stringify(bins) : null;
}

/**
 * Whether a result computed from the spec `key` is a rebin after one computed
 * from `last`. Never the first result (nothing to compare with), and never
 * without a spec on both sides.
 */
export function isRebin(last: string | null, key: string | null): boolean {
	return last !== null && key !== null && key !== last;
}

/**
 * Whether a result's rows are other bins than the last one's: a rebin, or the
 * same bins over a moved window (a pan past it, MarkConfig.binWindow). For the
 * renderer's map (`rebinSource`), which follows the rows: a window move is no
 * rebin for the value axis (isRebin), but its rows changed. Windows by value,
 * as stamped on each result; null is the whole extent.
 */
export function binRowsMoved(
	lastKey: string | null,
	lastWindow: BinWindow | null,
	key: string | null,
	window: BinWindow | null
): boolean {
	if (lastKey === null || key === null) return false;
	if (key !== lastKey) return true;
	if (lastWindow === window) return false;
	if (!lastWindow || !window) return true;
	return lastWindow[0] !== window[0] || lastWindow[1] !== window[1];
}

/**
 * Whether held rows spanning [heldLo, heldHi] cover what new rows spanning
 * [nextLo, nextHi] draw inside `view`: a hold draws the held rows until the
 * swap, so a part of the view where only the new rows have bars would stand
 * blank until then (a zoom out past a window's margin). Where neither has
 * bars (past the data's extent) is not a gap. `slack`: one new bin at either
 * end, whose part past the held rows is a bar that grows at the swap.
 */
export function heldCoversView(
	held: readonly [number, number],
	next: readonly [number, number],
	view: readonly [number, number],
	slack: number
): boolean {
	const lo = Math.max(next[0], view[0]);
	const hi = Math.min(next[1], view[1]);
	if (lo >= hi) return true;
	return held[0] <= lo + slack && held[1] >= hi - slack;
}
