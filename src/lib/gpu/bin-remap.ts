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
 * - null for anything else: the same rows, which fold, or rows that do not
 *   correspond, which snap (MorphedChannels tells those apart by row ids).
 */
export type RebinDecision =
	| { kind: 'forward'; map: Uint32Array; why: ForwardWhy }
	| { kind: 'hold'; map: Uint32Array }
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
	// The same keys in the same slots: equal counts can hide a different series.
	for (let c = 0; c < next.ids.length; c++) {
		const a = prev.ids[c];
		const b = next.ids[c];
		for (let f = 0; f < F; f++) {
			for (let s = 0; s < S; s++) {
				if (a[f * Bo * S + s] !== b[f * Bn * S + s]) return null;
			}
		}
	}

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
