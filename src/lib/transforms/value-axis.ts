/**
 * Which channel carries a mark's measure: what topN ranks by and normalize
 * divides, the other channel being the band they group by.
 *
 * Bars say it in their type (`barx` is horizontal, `bary` vertical). Any other
 * mark says it with its scales: a categorical y over a non-categorical x puts
 * the measure on x. A label on horizontal bars is such a mark, and so is a dot
 * or rule layer there. Deciding by mark type alone ranked those by their
 * category (y): their top N was a different set of categories than the bars',
 * and on a shared band axis the bars of the categories missing from it were
 * drawn nowhere.
 */

const CATEGORICAL = new Set(['band', 'point']);

export type ValueAxis = 'x' | 'y';

/** A mark's value axis from its type and its axes' scale types. */
export function markValueAxis(
	markType: string,
	xScaleType: string | null | undefined,
	yScaleType: string | null | undefined
): ValueAxis {
	if (markType === 'barx') return 'x';
	if (markType === 'bary') return 'y';
	const xCategorical = !!xScaleType && CATEGORICAL.has(xScaleType);
	const yCategorical = !!yScaleType && CATEGORICAL.has(yScaleType);
	return yCategorical && !xCategorical ? 'x' : 'y';
}

/** The value axis a transform reads from its mark config: the resolved one, else by mark type. */
export function valueAxisOf(
	config: { markType?: string; valueAxis?: unknown } | undefined
): ValueAxis {
	if (config?.valueAxis === 'x' || config?.valueAxis === 'y') return config.valueAxis;
	return config?.markType === 'barx' ? 'x' : 'y';
}
