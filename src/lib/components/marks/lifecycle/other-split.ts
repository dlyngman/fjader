/**
 * An Other bar's selected share, per row, and when a bar has one: the pure
 * half of MarkLifecycleV2's `otherSplit`, so it can be tested without a mark.
 */

/** A column of a result, as Arrow (flechette) hands it: one value per row. */
export interface RowColumn {
	at(row: number): unknown;
}

/** One computed split: the channel, and which Other rows are flat. */
export interface OtherSplit {
	/** 0 on rows that are not an Other row, `1 + share` (or a held position) on one. */
	split: Float32Array;
	/**
	 * 1 on an Other row whose two parts look the same: nothing selected (both
	 * lit), or none of its members selected (both dim). Its split position is
	 * invisible there, so it is held, and moving out of it lands rather than
	 * slides.
	 */
	flat: Uint8Array;
	/**
	 * Whether the split travels with this write (the renderer morphs it) or
	 * lands at once. It lands when a row leaves a flat state: both sides of it
	 * look the same at that moment, so a slide would be a movement the eye
	 * reads as meaning something; the fades show the change instead.
	 */
	slides: boolean;
	/**
	 * What the share is made of, per row (0 on a row with no split), for a
	 * tooltip to say: `picked` of `total` (Σ values over the selected members,
	 * over all), `pickedCount` of `memberCount` categories. With nothing
	 * selected everything counts as picked.
	 */
	picked: Float64Array;
	total: Float64Array;
	pickedCount: Int32Array;
	memberCount: Int32Array;
	/** The field has a selection: without one, everything counts as picked, which says nothing. */
	active: boolean;
}

/**
 * The split channel for the bar renderer, per row: share = Σ values · selected
 * / Σ values over the row's own member lists. Selection is by value (`decode`
 * maps an id to its value), so the NULL category needs nothing special. A row
 * whose members mix signs gets no split (0): a share of a sum that cancels
 * means nothing.
 *
 * `previous`: the last split for the SAME rows (the same result), when only the
 * selection changed. A flat row then holds its previous position, so going flat
 * (a selection cleared, or one that no longer reaches into Other) is a fade,
 * not a slide. Without it (a new result) every row takes its value, and the
 * split travels with the bar's own morph.
 *
 * Cost, measured: about 22 ns per Other member per call (the `selected.has`),
 * so 0.1 ms at 5 000 members and about 1.2 ms at 50 000. Fine per click. If
 * selection ever changes continuously (a brush on a band axis) over a very large
 * Other, test membership against a Uint8Array indexed by id, built once per
 * change, rather than a Set. The arrays allocated here are sized by rows.
 */
export function otherSplit(opts: {
	rows: number;
	band: RowColumn;
	otherId: number;
	ids: RowColumn;
	values: RowColumn;
	selected: ReadonlySet<unknown> | null;
	decode: ArrayLike<unknown>;
	previous?: OtherSplit | null;
}): OtherSplit {
	const { rows, band, otherId, ids, values, selected, decode } = opts;
	const previous = opts.previous && opts.previous.split.length === rows ? opts.previous : null;
	const split = new Float32Array(rows);
	const flat = new Uint8Array(rows);
	const pickedSums = new Float64Array(rows);
	const totals = new Float64Array(rows);
	const pickedCount = new Int32Array(rows);
	const memberCount = new Int32Array(rows);
	let slides = true;
	for (let row = 0; row < rows; row++) {
		if (Number(band.at(row)) !== otherId) continue;
		const memberIds = ids.at(row) as ArrayLike<number> | null;
		const memberValues = values.at(row) as ArrayLike<number> | null;
		if (!memberIds || !memberValues) continue;
		let total = 0;
		let picked = 0;
		let count = 0;
		let positive = false;
		let negative = false;
		for (let k = 0; k < memberIds.length; k++) {
			const v = memberValues[k];
			if (v > 0) positive = true;
			else if (v < 0) negative = true;
			total += v;
			if (selected == null || selected.has(decode[memberIds[k]])) {
				picked += v;
				count++;
			}
		}
		if (positive && negative) continue;
		pickedSums[row] = picked;
		totals[row] = total;
		pickedCount[row] = count;
		memberCount[row] = memberIds.length;
		const share =
			total === 0 ? (selected == null ? 1 : 0) : Math.min(1, Math.max(0, picked / total));
		const isFlat = selected == null || share === 0;
		flat[row] = isFlat ? 1 : 0;
		if (isFlat && previous) {
			const held = previous.split[row];
			split[row] = held > 0.5 ? held : 2;
		} else {
			split[row] = 1 + share;
		}
		if (previous && previous.flat[row] === 1 && !isFlat) slides = false;
	}
	return {
		split,
		flat,
		slides,
		picked: pickedSums,
		total: totals,
		pickedCount,
		memberCount,
		active: selected != null
	};
}

/**
 * Whether a bar's Other bucket can be split: its length must be what Other
 * sums, and a total. `length` is the bar's length channel, `by` the channel
 * topN ranks by (null: its default, the length), `expr` the length channel's
 * select expression.
 *
 * Other sums `by`, so a length channel that is not `by` is 0 on the Other row.
 * A bare COUNT or SUM, or a raw column (an ungrouped mark), is a total; a mean,
 * a max, a ratio or a distinct count summed into Other is not, and a share of
 * it would look exact while meaning nothing.
 */
export function splittable(length: string | undefined, by: string | null, expr: unknown): boolean {
	if (!length || (by ?? length) !== length) return false;
	if (typeof expr === 'string') return true;
	const node = expr as { type?: string; name?: string; isDistinct?: boolean } | null;
	if (!node || typeof node !== 'object') return false;
	if (node.type === 'COLUMN_REF') return true;
	if (node.type !== 'AGGREGATE' || node.isDistinct) return false;
	return node.name === 'count' || node.name === 'sum';
}
