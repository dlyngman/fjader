/**
 * The row layout of a dense histogram result, validated.
 *
 * `dense()` gives a binned mark one row per bin per crossed key (a series),
 * ordered by facet, then by bin, then by key: row `(f·B + b)·S + s`. That
 * order is what lets a fit read only the bins in a window and, later, a
 * rebin map a new bin onto the old ones it overlaps. Both read the rows at
 * stride S, so both depend on the layout being exactly that, and row
 * correspondence has silently not held more than once upstream (see
 * `alignmentKey` in MorphedChannels). So it is checked, not assumed: anything
 * other than F facets of the same B ascending bins, S rows each, is null, and
 * the caller falls back to what it did without a layout.
 *
 * Reads the lower edges at stride S only: O(F·B), never every row.
 */

export interface BinLayout {
	/** Rows per bin: the crossed keys (series), 1 without any. */
	series: number;
	/** Bins per facet. */
	bins: number;
	/** Facets, 1 without any. */
	facets: number;
}

/**
 * The layout of `rows` rows whose bin lower edges are `lower`, or null when
 * they are not F facets × B ascending bins × S rows per bin.
 *
 * A run of equal lower edges is one bin; its first and last rows are compared,
 * which suffices because the rows are sorted by edge. A facet starts where the
 * edge stops increasing, and every facet must repeat the first one's edges. A
 * NaN edge fails every comparison, so it is null too.
 */
export function binLayout(lower: ArrayLike<number>, rows: number): BinLayout | null {
	if (rows <= 0 || lower.length < rows) return null;

	const first = lower[0];
	let series = 1;
	while (series < rows && lower[series] === first) series++;
	if (!(first === first) || rows % series !== 0) return null;

	// Bins: runs of the first facet, while the edge keeps increasing.
	let bins = 1;
	while (bins * series < rows && lower[bins * series] > lower[(bins - 1) * series]) bins++;
	const perFacet = bins * series;
	if (rows % perFacet !== 0) return null;
	const facets = rows / perFacet;

	for (let f = 0; f < facets; f++) {
		for (let b = 0; b < bins; b++) {
			const start = f * perFacet + b * series;
			const edge = lower[start];
			// Same bins in every facet (exact: the same SQL expression made them).
			if (edge !== lower[b * series]) return null;
			// The run reaches S rows. One longer than S ended the bin count above:
			// its next stride read the same edge, which is not an increase.
			if (lower[start + series - 1] !== edge) return null;
		}
	}
	return { series, bins, facets };
}
