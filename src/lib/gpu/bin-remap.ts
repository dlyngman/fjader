import type { BinLayout } from '$lib/components/marks/lifecycle/bin-layout';

/**
 * The map a rebin morphs through: for each new bin, the old bins it overlaps
 * and by how much, so each new bar can start where the old ones it covers
 * were drawn (RemapShader).
 *
 * Built per BIN, not per row: `dense()` orders rows facet, bin, crossed key
 * (`binLayout`), and both sides must have the same facets and the same
 * crossed keys in the same order, so a row's old counterpart in an old bin is
 * at the same facet and series stride. The kernel derives the rows.
 *
 * Weights are overlap over the NEW bin's width: a split's children start at
 * their parent's value, a merge at its children's mean, months to weeks at the
 * blend of the months each week spans. The part of a new bin no old bin covers
 * (the extent's ends) starts at its own new value: `uncovered`, the same ratio.
 *
 * One `Uint32Array`, uploaded as the map buffer:
 *
 *   [0..7]   header: newBins, oldBins, series, facets, K (overlaps), 0, 0, 0
 *   then     offsets: newBins + 1 (CSR: bin b's overlaps are [offsets[b], offsets[b+1]))
 *   then     oldBin: K
 *   then     weight: K (f32 bits)
 *   then     uncovered: newBins (f32 bits)
 */
export const REMAP_HEADER_WORDS = 8;

/**
 * What a result is, relative to the rows the GPU holds:
 * - `forward`: a rebin to travel from through `map`: the new layout is
 *   drawn at once, each new bin starting where the old ones it covers were
 *   drawn (a split, or a merge that cannot hold).
 * - `hold`: a merge into coarser bins that nest the held ones. The held
 *   layout stays drawn and its rows travel to their parent's new value,
 *   gathered through `map` (held bins from new ones); the new layout is
 *   written when they land, through a forward map, invisibly.
 * - `cut`: a merge into coarser bins that do NOT nest the held ones (2 → 5,
 *   weeks → months). The held bars are cut at the new edges (`BinCut`), which
 *   looks the same; then it holds the cut layout as above.
 * - null for anything else: the same rows, which fold, or rows that do not
 *   correspond, which snap (MorphedChannels tells those apart by row ids).
 */
export type RebinDecision =
	| { kind: 'forward'; map: Uint32Array; why: ForwardWhy }
	| { kind: 'hold'; map: Uint32Array }
	| { kind: 'cut'; cut: BinCut }
	| null;

/**
 * Why a rebin goes forward rather than holding, for the transition log: a
 * split or a moved window (forward is the design), or a merge that could not
 * hold and why.
 */
export type ForwardWhy =
	| 'split'
	| 'window'
	| 'renderer cannot hold'
	| 'catch-up'
	| 'not covered'
	| 'not nested';

/**
 * How a renderer draws its rows over bins, which decides how a rebin can
 * animate. `interval`: each row spans its bin (rects, step areas, heatmap
 * cells), so siblings tile their parent and only the measure travels.
 * `point`: each row sits at one position in its bin (dots, line vertices,
 * text); declared for those renderers, not drawn by any yet.
 */
export type BinGeometry = 'interval' | 'point';

/**
 * A binned mark's side of a rebin (MarkLifecycleV2), for its renderer
 * (BaseGPURenderer.setBinning). The mark knows the bins and the layouts; the
 * renderer knows what it has written to the GPU.
 */
export interface RebinSource {
	/** The current result's version: one decision per version, on its first write. */
	dataVersion(): number;
	/**
	 * The current result against the layout last committed. Does not commit.
	 * `canHold`: whether the renderer can hold its layout through a merge.
	 */
	takeRebin(canHold: boolean): RebinDecision;
	/** The renderer has written the current result's layout to the GPU. */
	commitLayout(): void;
}

/** One side of a rebin: its rows' bin edges, their layout, and the crossed keys' ids per row. */
export interface BinRemapSide {
	lower: ArrayLike<number>;
	upper: ArrayLike<number>;
	layout: BinLayout;
	/** Each crossed key's ids (series, facet), one column per key, per row. */
	ids: readonly ArrayLike<number>[];
}

/**
 * Whether two sides have the same crossed keys in the same slots, per facet:
 * equal counts can hide a different series. Reads each facet's first run.
 */
function sameKeys(prev: BinRemapSide, next: BinRemapSide): boolean {
	const { series: S, facets: F } = next.layout;
	if (prev.layout.series !== S || prev.layout.facets !== F) return false;
	if (prev.ids.length !== next.ids.length) return false;
	const Bo = prev.layout.bins;
	const Bn = next.layout.bins;
	for (let c = 0; c < next.ids.length; c++) {
		const a = prev.ids[c];
		const b = next.ids[c];
		for (let f = 0; f < F; f++) {
			for (let s = 0; s < S; s++) {
				if (a[f * Bo * S + s] !== b[f * Bn * S + s]) return false;
			}
		}
	}
	return true;
}

/**
 * The map from `prev`'s bins to `next`'s, or null when the rows do not
 * correspond (a different series or facet set or order): the caller snaps.
 * Reads edges at stride and the ids of each facet's first run: O(B + F·S).
 */
export function buildBinRemap(
	prev: BinRemapSide,
	next: BinRemapSide,
	/**
	 * Overlaps below this share of the new bin's width are left out (and
	 * count as uncovered): slivers from Float32 edges that are one rounding
	 * apart, which would make a nested bin look like it straddles two.
	 */
	minWeight = 0
): Uint32Array | null {
	const { series: S, facets: F } = next.layout;
	if (prev.layout.series !== S || prev.layout.facets !== F) return null;
	if (prev.ids.length !== next.ids.length) return null;
	const Bo = prev.layout.bins;
	const Bn = next.layout.bins;
	if (!sameKeys(prev, next)) return null;

	// Overlaps, two pointers over the bins of facet 0 (every facet repeats them).
	const offsets = new Uint32Array(Bn + 1);
	const oldBin: number[] = [];
	const weight: number[] = [];
	const uncovered = new Float32Array(Bn);
	let first = 0;
	for (let b = 0; b < Bn; b++) {
		offsets[b] = oldBin.length;
		const lo = Number(next.lower[b * S]);
		const hi = Number(next.upper[b * S]);
		const width = hi - lo;
		if (!(width > 0)) {
			uncovered[b] = 1;
			continue;
		}
		// Old bins wholly left of this one are left of every later one too.
		while (first < Bo && Number(prev.upper[first * S]) <= lo) first++;
		let covered = 0;
		for (let k = first; k < Bo; k++) {
			const oLo = Number(prev.lower[k * S]);
			if (oLo >= hi) break;
			const overlap = Math.min(hi, Number(prev.upper[k * S])) - Math.max(lo, oLo);
			if (overlap <= 0 || overlap / width < minWeight) continue;
			oldBin.push(k);
			weight.push(overlap / width);
			covered += overlap;
		}
		uncovered[b] = Math.max(0, 1 - covered / width);
	}
	offsets[Bn] = oldBin.length;

	const K = oldBin.length;
	const words = new Uint32Array(REMAP_HEADER_WORDS + Bn + 1 + K + K + Bn);
	words[0] = Bn;
	words[1] = Bo;
	words[2] = S;
	words[3] = F;
	words[4] = K;
	let at = REMAP_HEADER_WORDS;
	words.set(offsets, at);
	at += Bn + 1;
	words.set(oldBin, at);
	at += K;
	new Float32Array(words.buffer, at * 4, K).set(weight);
	at += K;
	new Float32Array(words.buffer, at * 4, Bn).set(uncovered);
	return words;
}

/** Edge rounding tolerated when telling nested bins (`buildBinRemap`'s minWeight, `isNested`). */
export const NEST_EPSILON = 1e-3;

/**
 * Whether a map built from new bins onto the held ones (`buildBinRemap(new,
 * held, NEST_EPSILON)`) nests: every held bin lies inside exactly one new bin
 * (one overlap, weight ≥ 1 − ε) or outside all of them (none: a held bin in
 * the window's margin with no parent), and at least one has a parent. Reads
 * the map's offsets and weights: O(held bins).
 */
export function isNested(map: Uint32Array, epsilon = NEST_EPSILON): boolean {
	const bins = map[0];
	const K = map[4];
	const offsetsAt = REMAP_HEADER_WORDS;
	const weightAt = offsetsAt + bins + 1 + K;
	const weights = new Float32Array(map.buffer, map.byteOffset, map.length);
	let parented = 0;
	for (let b = 0; b < bins; b++) {
		const n = map[offsetsAt + b + 1] - map[offsetsAt + b];
		if (n === 0) continue;
		if (n > 1 || weights[weightAt + map[offsetsAt + b]] < 1 - epsilon) return false;
		parented++;
	}
	return parented > 0;
}

/**
 * The held bars cut at a merge's new edges: each held bin split where a new
 * bin edge falls inside it, so every piece lies in one held bin and one new
 * bin. Drawn at the held values it looks like the held bars; drawn at the new
 * values, like the new bars. So a merge whose bins do not nest (2 → 5, weeks
 * → months) can travel in it and swap at both ends without showing.
 */
export interface BinCut {
	/** The pieces as a side: edges per row (as drawn), the layout (pieces as bins), ids. */
	side: BinRemapSide & { lower: Float32Array; upper: Float32Array };
	/** Held → pieces (RemapShader: `from` from the held rows on screen). */
	fromHeld: Uint32Array;
	/** New → pieces (the gather: `to` from the new rows). */
	fromNew: Uint32Array;
	/**
	 * Per piece and facet (facet-major), the first held row of its held bin:
	 * a held per-row array becomes the pieces' by copying runs of `series`.
	 */
	heldRun: Uint32Array;
	/** Held rows, for checking that an array is in the held layout. */
	heldRows: number;
	/**
	 * Per row, which of its edges the cut made (SEAM_LOWER, SEAM_UPPER) and
	 * which it shares with a piece of the same new bin (SIBLING_*): a renderer
	 * that insets its bars leaves cut edges flush, so the pieces of one held
	 * bar still draw as that bar, and fades sibling edges closed before the
	 * swap.
	 */
	seams: Uint32Array;
}

/**
 * Seam flags, per row, for a renderer that insets its bars (see BinCut.seams
 * and `siblingSeams`). CUT edges (a held bar cut at a new edge) draw flush.
 * SIBLING edges (between two rows that are one bar in the other layout) draw
 * their inset scaled by the renderer's seam fade, so the gaps close before a
 * merge's swap and open after a split.
 */
export const SEAM_LOWER = 1;
export const SEAM_UPPER = 2;
export const SIBLING_LOWER = 4;
export const SIBLING_UPPER = 8;

/**
 * Each destination bin's single source bin in a map (the remap layout), or −1
 * where it has none or several: a split's children have one parent each, a
 * hold's held bins one parent or none. O(destination bins).
 */
export function parentsFromMap(map: Uint32Array): Int32Array {
	const bins = map[0];
	const offsetsAt = REMAP_HEADER_WORDS;
	const srcAt = offsetsAt + bins + 1;
	const parents = new Int32Array(bins);
	for (let b = 0; b < bins; b++) {
		const start = map[offsetsAt + b];
		parents[b] = map[offsetsAt + b + 1] - start === 1 ? map[srcAt + start] : -1;
	}
	return parents;
}

/**
 * The SIBLING seams of a dense layout (F facets × bins × S series) whose
 * bins have `parents`: an edge between two adjacent bins with the same
 * parent. OR'd into `into` when given. A run fill per bin and facet.
 */
export function siblingSeams(
	parents: ArrayLike<number>,
	series: number,
	facets: number,
	into?: Uint32Array
): Uint32Array {
	const bins = parents.length;
	const out = into ?? new Uint32Array(bins * series * facets);
	for (let b = 0; b < bins; b++) {
		const p = parents[b];
		if (p < 0) continue;
		const bits =
			(b > 0 && parents[b - 1] === p ? SIBLING_LOWER : 0) |
			(b < bins - 1 && parents[b + 1] === p ? SIBLING_UPPER : 0);
		if (!bits) continue;
		for (let f = 0; f < facets; f++) {
			const at = (f * bins + b) * series;
			for (let s = 0; s < series; s++) out[at + s] |= bits;
		}
	}
	return out;
}

/** Whether any row has a seam: a layout with none needs no seam buffer. */
export function hasSeams(seams: Uint32Array): boolean {
	for (let i = 0; i < seams.length; i++) if (seams[i] !== 0) return true;
	return false;
}

/**
 * Cut `held`'s bins at `next`'s edges (`BinCut`), or null when the rows do
 * not correspond (other keys) or nothing is cut. A cut within ε of a held
 * edge is the edge (Float32 rounding). A piece outside every new bin (the
 * window's margin, the extent's end) goes to the nearest one: off screen.
 * O(held bins + new bins) for the pieces, plus a run copy per piece and facet.
 */
export function buildBinCut(
	held: BinRemapSide,
	next: BinRemapSide,
	epsilon = NEST_EPSILON
): BinCut | null {
	if (!sameKeys(held, next)) return null;
	const { series: S, facets: F } = held.layout;
	const Bh = held.layout.bins;
	const Bn = next.layout.bins;
	if (Bh === 0 || Bn === 0) return null;

	// The new bins' edges, ascending: lower edges, then the last upper.
	const edges: number[] = [];
	for (let c = 0; c < Bn; c++) edges.push(Number(next.lower[c * S]));
	edges.push(Number(next.upper[(Bn - 1) * S]));

	const pieceLo: number[] = [];
	const pieceHi: number[] = [];
	const heldParent: number[] = [];
	const newParent: number[] = [];
	let e = 0;
	let c = 0;
	for (let b = 0; b < Bh; b++) {
		const lo = Number(held.lower[b * S]);
		const hi = Number(held.upper[b * S]);
		const tol = epsilon * (hi - lo);
		let start = lo;
		while (e < edges.length && edges[e] <= lo + tol) e++;
		for (let k = e; k < edges.length && edges[k] < hi - tol; k++) {
			pieceLo.push(start);
			pieceHi.push(edges[k]);
			heldParent.push(b);
			start = edges[k];
		}
		pieceLo.push(start);
		pieceHi.push(hi);
		heldParent.push(b);
	}
	const P = pieceLo.length;
	if (P === Bh) return null;
	// Each piece's new bin, by its middle: the new bins are ascending.
	for (let p = 0; p < P; p++) {
		const mid = (pieceLo[p] + pieceHi[p]) / 2;
		while (c < Bn - 1 && Number(next.upper[c * S]) <= mid) c++;
		newParent.push(c);
	}

	const rows = P * S * F;
	const lower = new Float32Array(rows);
	const upper = new Float32Array(rows);
	const seams = new Uint32Array(rows);
	const heldRun = new Uint32Array(P * F);
	for (let f = 0; f < F; f++) {
		for (let p = 0; p < P; p++) {
			const at = (f * P + p) * S;
			lower.fill(pieceLo[p], at, at + S);
			upper.fill(pieceHi[p], at, at + S);
			heldRun[f * P + p] = (f * Bh + heldParent[p]) * S;
			// A piece's edge is a cut unless it is its held bar's own edge.
			const seam =
				(p > 0 && heldParent[p - 1] === heldParent[p] ? SEAM_LOWER : 0) |
				(p < P - 1 && heldParent[p + 1] === heldParent[p] ? SEAM_UPPER : 0);
			if (seam) seams.fill(seam, at, at + S);
		}
	}
	// Ids as numbers, compared by value with the next side's: one run copy
	// per piece and facet (a typed column converts on `set`).
	const ids = held.ids.map((column) => {
		const source = ArrayBuffer.isView(column)
			? (column as unknown as Float64Array)
			: Float64Array.from(column);
		const out = new Float64Array(rows);
		for (let i = 0; i < P * F; i++) {
			const from = heldRun[i];
			out.set(source.subarray(from, from + S), i * S);
		}
		return out;
	});
	// Pieces of one new bin become one bar: their shared edges are siblings.
	siblingSeams(newParent, S, F, seams);
	return {
		side: { lower, upper, layout: { series: S, bins: P, facets: F }, ids },
		fromHeld: singleParentMap(P, Bh, S, F, heldParent),
		fromNew: singleParentMap(P, Bn, S, F, newParent),
		heldRun,
		heldRows: Bh * S * F,
		seams
	};
}

/** A map (the remap layout above) where each destination bin has one source bin, weight 1. */
function singleParentMap(
	dstBins: number,
	srcBins: number,
	S: number,
	F: number,
	parent: readonly number[]
): Uint32Array {
	const K = dstBins;
	const words = new Uint32Array(REMAP_HEADER_WORDS + dstBins + 1 + K + K + dstBins);
	words[0] = dstBins;
	words[1] = srcBins;
	words[2] = S;
	words[3] = F;
	words[4] = K;
	let at = REMAP_HEADER_WORDS;
	for (let b = 0; b <= dstBins; b++) words[at + b] = b;
	at += dstBins + 1;
	words.set(parent, at);
	at += K;
	new Float32Array(words.buffer, at * 4, K).fill(1);
	// uncovered: zeros
	return words;
}

/**
 * A held per-row array as the cut's pieces': each piece copies its held
 * bin's run of `series` rows. Four bytes per row (f32 and u32 alike), or null
 * when `data` is not in the held layout.
 */
export function cutRows(
	data: AllowSharedBufferSource,
	cut: BinCut
): Uint32Array<ArrayBuffer> | null {
	const view = ArrayBuffer.isView(data)
		? new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2)
		: new Uint32Array(data);
	if (view.length !== cut.heldRows) return null;
	const S = cut.side.layout.series;
	const out = new Uint32Array(cut.heldRun.length * S);
	for (let i = 0; i < cut.heldRun.length; i++) {
		const from = cut.heldRun[i];
		out.set(view.subarray(from, from + S), i * S);
	}
	return out;
}
