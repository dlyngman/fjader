import { isBinExpression } from '$lib/sql/bin';

/**
 * The channels a path mark (a line, an area) selects for the axis it runs
 * along, from the `value` given for that axis.
 *
 * A plain column or expression is that one channel.
 *
 * A `bin()` is three:
 * - the point, at the bin's CENTRE: a count over `[lo, hi)` belongs in the
 *   middle of that span, where a bar over the same bin has its centre, not at
 *   its start, half a bin to the left of its data. A `bin()` given an `offset`
 *   of its own keeps it: `bin('date', { offset: 0 })` draws a daily count at
 *   its date.
 * - the bin's two edges, as `x1`/`x2` (or `y1`/`y2`). Not drawn, not uploaded:
 *   they are what tells the lifecycle the mark is binned and where each bin
 *   starts and ends, as a rect mark's edges do. The centre cannot stand in for
 *   them, since calendar bins are not of one width.
 *
 * In the query, not in a shader: a shader would need the next bin's row to
 * find a centre, which a padded result has and an unpadded one does not, so
 * the path would shift half a bin wherever the padding gave up.
 *
 * The centre is the midpoint in the data's units. On a log axis that is right
 * of a bar's visual centre, which is the geometric mean of its edges.
 */
export function pathDimChannels(axis: 'x' | 'y', value: unknown): Record<string, unknown> {
	if (!isBinExpression(value)) return { [axis]: value };
	const point = value.options.offset === undefined ? value.withOffset(0.5) : value;
	return {
		[axis]: point,
		[`${axis}1`]: value.withOffset(0),
		[`${axis}2`]: value.withOffset(1)
	};
}

/**
 * The tooltip columns for the axis a path mark runs along: a `bin()`'s two
 * edges, as the low and high of that axis. The tooltip then shows the bin as
 * a range ("0–6"), as it does for a bar over the same bin, and a pointer
 * anywhere inside the bin is at that point. Without them the point's centre
 * and both edges are three values under one field name, and the last one
 * read, the upper edge, is what shows. Nothing for a plain column.
 */
export function pathDimTooltipColumns(
	axis: 'x' | 'y',
	value: unknown
): { xLow?: string; xHigh?: string; yLow?: string; yHigh?: string } {
	if (!isBinExpression(value)) return {};
	return axis === 'x' ? { xLow: 'x1', xHigh: 'x2' } : { yLow: 'y1', yHigh: 'y2' };
}
