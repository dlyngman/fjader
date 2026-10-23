/**
 * When a chart's frame uniform has stopped describing the chart.
 *
 * The uniform carries one piece of DERIVED state: which facet id its cell
 * shows. A facet reorder moves it without touching the chart, and keeping it
 * current by pushing would mean every writer of the facet order remembering to
 * rewrite it — which a reorder never did. So it is reconciled instead, once per
 * frame. Extracted here because the reconcile itself is reachable only through
 * a device and a running loop, while the RULE is a comparison over plain values.
 */

/** What the reconcile compares. A `ChartConfig`, narrowed to the fields it reads. */
export interface FrameUniformInputs {
	/** The facet scale, whose display order decides which id this cell shows. */
	facetScale: { _version: number } | null;
	/** The facet order the uniform was last written against. */
	_facetVersion: number;
}

export function frameUniformIsStale(chart: FrameUniformInputs): boolean {
	return !!chart.facetScale && chart.facetScale._version !== chart._facetVersion;
}
