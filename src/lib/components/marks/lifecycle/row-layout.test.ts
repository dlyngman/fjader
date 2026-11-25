import { describe, it, expect } from 'vitest';
import { layoutFor, rowLayoutOf, RUNS, type RowLayout } from './row-layout';

/** Rows bin first: every bin's edge repeated once per series, per facet. */
function grid(facets: number, bins: number, series: number): Float32Array {
	const x = new Float32Array(facets * bins * series);
	let i = 0;
	for (let f = 0; f < facets; f++)
		for (let b = 0; b < bins; b++) for (let s = 0; s < series; s++) x[i++] = b * 10;
	return x;
}

/** Rows series first: each series walks the bins, as an unpadded path query returns them. */
function runs(bins: number, series: number): Float32Array {
	const x = new Float32Array(bins * series);
	let i = 0;
	for (let s = 0; s < series; s++) for (let b = 0; b < bins; b++) x[i++] = b * 10;
	return x;
}

const columns = (x: Float32Array | null) => (channel: string) => (channel === 'x' ? x : null);

describe('rowLayoutOf', () => {
	it('is runs when no transform promised an order', () => {
		const x = runs(6, 3);
		expect(rowLayoutOf(null, x.length, columns(x))).toBe(RUNS);
		expect(rowLayoutOf([], x.length, columns(x))).toBe(RUNS);
	});

	it('is a grid when the result was padded: bins, series and facets from the rows', () => {
		const x = grid(1, 24, 4);
		expect(rowLayoutOf(['x', 'fill'], x.length, columns(x))).toEqual({
			kind: 'grid',
			facets: 1,
			bins: 24,
			series: 4
		});
		const faceted = grid(3, 8, 2);
		expect(rowLayoutOf(['x', 'fill'], faceted.length, columns(faceted), true)).toEqual({
			kind: 'grid',
			facets: 3,
			bins: 8,
			series: 2
		});
		const single = grid(1, 12, 1);
		expect(rowLayoutOf(['x'], single.length, columns(single))).toMatchObject({
			kind: 'grid',
			bins: 12,
			series: 1
		});
	});

	it('takes the kind from the declaration, and refuses rows that came back series first', () => {
		// Series-first rows of equal length read as S facets of one series each:
		// the rows alone cannot say. Undeclared they are runs; declared a grid on
		// an unfaceted mark, they are the wrong order, which is refused.
		const x = runs(6, 3);
		expect(rowLayoutOf(null, x.length, columns(x)).kind).toBe('runs');
		expect(rowLayoutOf(['x', 'fill'], x.length, columns(x)).kind).toBe('refused');
		// Faceted, the bins may repeat, but a crossed series always has a row
		// for -1 beside its own: one row per bin is still series order.
		expect(rowLayoutOf(['x', 'fill'], x.length, columns(x), true).kind).toBe('refused');
		// A faceted grid proper: bins repeat per cell, several rows in each.
		const cells = grid(3, 6, 2);
		expect(rowLayoutOf(['x', 'fill'], cells.length, columns(cells), true).kind).toBe('grid');
	});

	it('without a crossed series never refuses: bin order is run order', () => {
		// One series, whole bins: a grid of one, which reads as runs as well.
		const one = grid(1, 12, 1);
		expect(rowLayoutOf(['x'], one.length, columns(one))).toEqual({
			kind: 'grid',
			facets: 1,
			bins: 12,
			series: 1
		});
		// Two bin edges that collide in f32: a run of two, which no check needs.
		const collided = Float32Array.from([0, 10, 20, 20, 30, 40]);
		expect(rowLayoutOf(['x'], collided.length, columns(collided))).toBe(RUNS);
		// Not whole bins, a column missing, bins that repeat unfaceted: all runs.
		const ragged = grid(1, 6, 3).subarray(0, 16);
		expect(rowLayoutOf(['x'], ragged.length, columns(ragged))).toBe(RUNS);
		expect(rowLayoutOf(['x'], 12, columns(null))).toBe(RUNS);
		const repeated = runs(6, 3);
		expect(rowLayoutOf(['x'], repeated.length, columns(repeated))).toBe(RUNS);
		// Faceted without a series: one row per bin per cell.
		const cells = grid(3, 6, 1);
		expect(rowLayoutOf(['x', '__facet'], cells.length, columns(cells), true)).toMatchObject({
			kind: 'grid',
			facets: 3,
			series: 1
		});
	});

	it('refuses padded rows that are not a whole grid, and never reads them as runs', () => {
		const x = grid(1, 6, 3).subarray(0, 16);
		const layout = rowLayoutOf(['x', 'fill'], x.length, columns(x));
		expect(layout.kind).toBe('refused');
		const missing = rowLayoutOf(['x', 'fill'], 18, columns(null));
		expect(missing).toMatchObject({ kind: 'refused' });
	});

	it('is runs for an empty result', () => {
		expect(rowLayoutOf(['x', 'fill'], 0, columns(new Float32Array(0)))).toBe(RUNS);
	});
});

describe('layoutFor: what a renderer can address', () => {
	const grid = (series: number): RowLayout => ({ kind: 'grid', facets: 1, bins: 24, series });

	it('hands a grid to a renderer that reads grids, and runs to anyone', () => {
		expect(layoutFor(grid(4), ['runs', 'grid'], 'areay')).toEqual(grid(4));
		expect(layoutFor(RUNS, ['runs'], 'line')).toBe(RUNS);
		expect(layoutFor(RUNS, ['runs', 'grid'], 'areay')).toBe(RUNS);
	});

	it('refuses a grid of several series to a renderer of runs, by name', () => {
		const refused = layoutFor(grid(4), ['runs'], 'line');
		expect(refused.kind).toBe('refused');
		expect(refused).toMatchObject({ why: expect.stringContaining('line cannot read yet') });
	});

	it('lets a renderer of runs read a grid of one series: its bins follow each other', () => {
		expect(layoutFor(grid(1), ['runs'], 'line')).toEqual(grid(1));
	});

	it('passes a refusal through', () => {
		const refused: RowLayout = { kind: 'refused', why: 'not whole bins' };
		expect(layoutFor(refused, ['runs', 'grid'], 'areay')).toBe(refused);
	});
});
