/**
 * The `transformKey` a mark with a category-reducing transform (topN) adds to
 * its band scale's config, which is part of the scale's registry key.
 *
 * It names the table, the transform (N included) and the chart. A topN axis
 * shows the categories its own query returned, and a band scale resolves the
 * union of every mark registered on it, so two charts may share one only if
 * they always return the same categories. Two charts with the identical topN
 * do not: they receive different filters (a brush skips its own chart), and a
 * shared scale would show each the other's top N as empty slots, and share one
 * Other bucket between two different sets of members.
 *
 * The chart is its ChartConfig object, which a faceted chart's cells share, so
 * facets keep one axis; a bar and its value labels in one chart share one too.
 */

const chartKeys = new WeakMap<object, string>();
let nextChartKey = 0;

/** A name for a chart, stable while its ChartConfig lives, shared by its cells. */
function chartKeyOf(chart: object): string {
	let key = chartKeys.get(chart);
	if (!key) chartKeys.set(chart, (key = `chart${nextChartKey++}`));
	return key;
}

export function transformScaleKey(
	table: string,
	transformKey: string,
	chart: object | null | undefined
): string {
	return chart ? `${table}:${transformKey}@${chartKeyOf(chart)}` : `${table}:${transformKey}`;
}
