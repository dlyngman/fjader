/**
 * The axis a Rect mark fits to what is in view (`fitDomain`), as RectYMark and
 * RectXMark resolve it. One rule for both: two copies of it drifted once, and
 * a horizontal histogram's `true` fitted its binned axis.
 *
 * - A histogram with no `fitDomain` fits its count axis: zoomed or panned away
 *   from the tallest bin, a fixed axis leaves the bars in view a sliver of the
 *   plot. `false` keeps the axis fixed.
 * - `true` means the count axis on a histogram; `y` on any other rect.
 * - `'x'` or `'y'` is taken as given.
 *
 * Null: no fitting.
 */
export function histogramFitAxis(
	fitDomain: 'x' | 'y' | boolean | undefined,
	isHistogram: boolean,
	/** The histogram's count axis: y for RectYMark (bins on x), x for RectXMark. */
	countAxis: 'x' | 'y'
): 'x' | 'y' | null {
	const fd = fitDomain ?? (isHistogram ? countAxis : undefined);
	if (!fd) return null;
	if (fd === true) return isHistogram ? countAxis : 'y';
	return fd;
}
