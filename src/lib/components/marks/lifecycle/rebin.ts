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

import type { BinPadding } from '$lib/types';

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
