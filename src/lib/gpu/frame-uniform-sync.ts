/**
 * When a chart's frame uniform has stopped describing the chart.
 *
 * The uniform carries DERIVED state — the index of the chart's scales, and
 * which facet id its cell shows — and both move without anything touching the
 * chart. Keeping it current by pushing means every writer of an input
 * remembering to rewrite it, and the writers did not: a facet reorder never
 * did, and `setChartScaleMapping` did not either. The second cost a chart that
 * rendered every mark through another chart's scale — correct scale, domain,
 * slot table and axis, wrong pixels — because its uniform kept the index it was
 * given before its scales resolved, which reads as 0, the first scale on the
 * page.
 *
 * So it is reconciled instead, once per frame, the way scale params already
 * are. Extracted here because the reconcile itself is reachable only through a
 * device and a running loop, while the RULE is three comparisons over plain
 * values — the same reason the slot packer is its own module.
 */

/** What the reconcile compares. A `ChartConfig`, narrowed to the fields it reads. */
export interface FrameUniformInputs {
	/** The scales the chart currently resolves through. */
	xScaleId: string | null;
	yScaleId: string | null;
	/** The facet scale, whose display order decides which id this cell shows. */
	facetScale: { _version: number } | null;
	/** What the uniform was last written against. */
	_facetVersion: number;
	_uniformTopology: number;
	_uniformXScaleId: string | null;
	_uniformYScaleId: string | null;
}

/**
 * `topology` is a counter bumped whenever scale indices are reassigned.
 *
 * It is the clause that is easy to mistake for redundant, and it is not: the
 * uniform holds a scale's INDEX, and indices are positional. A rebuild can move
 * a chart's scale to a different slot without the chart's ids changing at all,
 * and comparing ids alone would see nothing while every shader on that chart
 * read someone else's params.
 */
export function frameUniformIsStale(chart: FrameUniformInputs, topology: number): boolean {
	if (chart.facetScale && chart.facetScale._version !== chart._facetVersion) return true;
	if (chart._uniformTopology !== topology) return true;
	return chart._uniformXScaleId !== chart.xScaleId || chart._uniformYScaleId !== chart.yScaleId;
}
