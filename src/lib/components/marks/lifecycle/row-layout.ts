import { binLayout } from './bin-layout';

/**
 * How a mark's result rows are laid out, which a path renderer (lines, areas)
 * must know to join each point to the next one of its series.
 *
 * - `runs`: each series' rows are contiguous, in the order the path is drawn.
 *   Unpadded results: a raw series, or a query `dense()` did not pad.
 * - `grid`: `dense()` padded the result to one row per bin per series and
 *   ordered it bin first, row `(f·B + b)·S + s`. A point's neighbour is S rows
 *   away, not the next row.
 * - `refused`: the query was padded, so its rows are bin first, but they are
 *   not a whole grid. Read as runs they would join every series to the next
 *   and draw nothing, silently, so nothing reads them as runs.
 *
 * DECLARED by the query, not inferred from the rows: S equal series in series
 * order read as S facets of one series each, so the rows alone cannot say
 * which they are. `aligned` is the order the transforms promised for this
 * result (TransformCompiler.alignment), null when none did; the rows are then
 * checked against it, and against what the query says of facets and series,
 * which is what catches rows that came back in another order.
 */
export type RowLayout =
	| { readonly kind: 'runs' }
	| {
			readonly kind: 'grid';
			readonly facets: number;
			readonly bins: number;
			readonly series: number;
	  }
	| { readonly kind: 'refused'; readonly why: string };

export const RUNS: RowLayout = { kind: 'runs' };

/** The layouts a renderer that joins rows into a path can address. */
export type ReadableLayout = 'runs' | 'grid';

/** A renderer that addresses a padded grid's rows by bin and series, as well as runs. */
export const READS_RUNS_AND_GRIDS: readonly ReadableLayout[] = ['runs', 'grid'];

/**
 * `layout` as a renderer that reads `kinds` gets it: itself when the renderer
 * can address it, refused otherwise. A grid of one series is runs as well (its
 * bins follow each other, per facet), so a renderer of runs reads it; a grid
 * of several is not, and read as runs it joins every series to the next.
 */
export function layoutFor(
	layout: RowLayout,
	kinds: readonly ReadableLayout[],
	renderer: string
): RowLayout {
	if (layout.kind !== 'grid' || kinds.includes('grid')) return layout;
	if (layout.series === 1) return layout;
	return {
		kind: 'refused',
		why:
			`its ${layout.series} series are padded to one row per bin and ordered bin first, ` +
			`which ${renderer} cannot read yet`
	};
}

/** The facet channel of a faceted mark's query. */
const FACET = '__facet';

/**
 * The layout of `rows` result rows. `aligned`: the channels the result is
 * ordered by when a transform padded it, the band (bin) channel first, then
 * the crossed keys. `faceted`: whether the query has a facet channel.
 * `column` reads a result column. Reads the band column at stride (binLayout),
 * never every row.
 */
export function rowLayoutOf(
	aligned: readonly string[] | null,
	rows: number,
	column: (channel: string) => ArrayLike<number> | null,
	faceted = false
): RowLayout {
	if (!aligned || aligned.length === 0 || rows === 0) return RUNS;
	const band = aligned[0];
	// Whether the padding crossed the bins with a series. Without one, bin
	// order is run order: nothing is interleaved, so the rows are safe to read
	// as runs whatever the check below finds, as they were before there was a
	// check (two bin edges that collide in f32 are a run of two, for one).
	const crossed = aligned.slice(1).some((channel) => channel !== FACET);
	const edges = column(band);
	if (!edges) {
		if (!crossed) return RUNS;
		return { kind: 'refused', why: `the result has no "${band}" column to read its bins from` };
	}
	const layout = binLayout(edges, rows);
	if (!layout) {
		if (!crossed) return RUNS;
		return {
			kind: 'refused',
			why:
				`the result was padded to one row per bin per series, ordered by "${band}", ` +
				`but its ${rows} rows are not whole bins of equal size`
		};
	}
	if (!crossed) {
		// A grid of one series when it reads as one; runs otherwise.
		return layout.series === 1 && (faceted || layout.facets === 1)
			? { kind: 'grid', facets: layout.facets, bins: layout.bins, series: 1 }
			: RUNS;
	}
	// Rows in another order still read as some grid: series-first rows as one
	// facet per series, of one series each. What the query declares rules those
	// readings out.
	if (!faceted && layout.facets !== 1) {
		return {
			kind: 'refused',
			why:
				`the result should be ordered by "${band}" first, but its bins repeat ` +
				`${layout.facets} times over, as if it were ordered by series`
		};
	}
	// A crossed key always brings -1 with it (a value its dim does not hold
	// yet), so a crossed result has at least two rows per bin. One row per bin
	// is a faceted result in series order, read as a facet per series: it would
	// draw, and then morph every series into another's rows.
	if (layout.series === 1) {
		return {
			kind: 'refused',
			why:
				`the result should have a row per series in each bin of "${band}", but has one: ` +
				`its ${layout.facets} runs of bins look ordered by series`
		};
	}
	return { kind: 'grid', facets: layout.facets, bins: layout.bins, series: layout.series };
}
