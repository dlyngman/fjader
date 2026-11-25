/**
 * WGSL for renderers that join rows into a path (Lines, Areas): which row an
 * instance is, which row is its neighbour along the path, and where a series
 * ends. One copy, because the two renderers must agree on it exactly.
 *
 * A path's rows come in two layouts (row-layout.ts):
 * - RUNS: each series' rows are contiguous. Instance i is row i, joined to
 *   row i + 1 when that is the same series.
 * - A GRID: `dense()` padded the result to one row per bin per series and
 *   ordered it bin first, row `(f·B + b)·S + s`. The instances walk it series
 *   by series, so a series still draws whole before the next (where lines
 *   cross, the order does not flip at every bin): within a facet, instance r
 *   is series `r / B` at bin `r % B`, and its neighbour is S rows on.
 *
 * Which it is, is a mark constant, not a pipeline variant: `dense()` can
 * refuse a result (past its row limit), so one mark's layout can change from
 * one result to the next, and a branch per vertex costs less than a pipeline
 * swap per result.
 *
 * The including shader provides:
 * - `markConstants` with `pointCount`, `gridBins` and `gridSeries` (u32), a
 *   grid's bins and series per facet, `gridBins` 0 for runs. Written out in
 *   each struct, not spliced in, so the uniform size test reads them;
 * - `seriesValues: array<f32>`, each row's series.
 */

import { isNegativeOrNanExpr } from './NanShaderLib';

export const PATH_WGSL = `
  struct PathRow {
    row: u32,  // The row this instance draws from
    step: u32, // Rows from it to its neighbour along the path
    bin: u32   // Its bin, in a grid
  };

  fn pathIsGrid() -> bool {
    return markConstants.gridBins > 0u;
  }

  // The row instance i draws from, and the stride to its neighbour.
  fn pathRow(instanceIdx: u32) -> PathRow {
    var p: PathRow;
    p.row = instanceIdx;
    p.step = 1u;
    p.bin = 0u;
    if (pathIsGrid()) {
      let bins = markConstants.gridBins;
      let series = markConstants.gridSeries;
      let perFacet = bins * series;
      let inFacet = instanceIdx % perFacet;
      p.bin = inFacet % bins;
      p.row = ((instanceIdx / perFacet) * bins + p.bin) * series + inFacet / bins;
      p.step = series;
    }
    return p;
  }

  // Whether this point is the last along its path: of the data, or of its
  // series in a grid, whose row at the next stride is another facet's first bin.
  // (In runs, the next row of another series is told apart by the series values.)
  fn pathEnds(p: PathRow) -> bool {
    return p.row + p.step >= markConstants.pointCount ||
      (pathIsGrid() && p.bin + 1u >= markConstants.gridBins);
  }

  // The point before this one for a curve's tangent, or itself at the start of
  // its series: by the bin in a grid, by the series values in runs.
  fn pathPrev(p: PathRow, seriesCurr: f32) -> u32 {
    if (pathIsGrid()) {
      if (p.bin > 0u) { return p.row - p.step; }
      return p.row;
    }
    if (p.row > 0u && seriesValues[p.row - 1u] == seriesCurr) { return p.row - 1u; }
    return p.row;
  }

  // The point after the next one, or the next one at the end of its series.
  fn pathAfter(p: PathRow, seriesNext: f32) -> u32 {
    let next = p.row + p.step;
    if (pathIsGrid()) {
      if (p.bin + 2u < markConstants.gridBins) { return next + p.step; }
      return next;
    }
    if (next + 1u < markConstants.pointCount && seriesValues[next + 1u] == seriesNext) {
      return next + 1u;
    }
    return next;
  }
`;

/**
 * A faceted path renderer's WGSL: the facet index buffer at `binding`, the
 * discard of a point outside the cell being drawn, and of a segment whose next
 * point is. A storage buffer, not a vertex attribute as Dots and Rects use:
 * the boundary check reads another row's facet. Expects `rowIdx` (the row
 * this instance draws from, not the instance index) and `nextIdx` in scope.
 */
export function pathFacetWGSL(binding: number): {
	binding: string;
	discard: string;
	boundary: string;
} {
	// A negative or NaN facet (a NULL facet: -1 when padded, NaN when kept) is
	// no cell; u32() would put it in cell 0.
	const outside = (row: string) =>
		`(${isNegativeOrNanExpr(`facetIndices[${row}]`)} || u32(facetIndices[${row}]) != frameUniforms.activeFacetIdx)`;
	return {
		binding: `\n  @group(1) @binding(${binding}) var<storage, read> facetIndices: array<f32>;`,
		discard: `
    // Facet filtering: discard vertices not belonging to this cell
    if (${outside('rowIdx')}) {
      var degen: VertexOutput;
      degen.position = DISCARD_POS;
      return degen;
    }`,
		boundary: `
    // Facet boundary: discard segment if next point is in a different facet
    if (${outside('nextIdx')}) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }`
	};
}
