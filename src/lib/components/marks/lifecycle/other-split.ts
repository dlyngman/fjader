/**
 * An Other bar's selected share, per row, and when a bar has one: the pure
 * half of MarkLifecycleV2's `otherSplit`, so it can be tested without a mark.
 */

/** A column of a result, as Arrow (flechette) hands it: one value per row. */
export interface RowColumn {
	at(row: number): unknown;
}

/**
 * The split channel for the bar renderer: 0 on every row that is not an Other
 * row, `1 + share` on one, where share = Σ values · selected / Σ values over the
 * row's own member lists. Selection is by value (`decode` maps an id to its
 * value), so the NULL category needs nothing special; with nothing selected
 * (`selected` null) every share is 1. A row whose members mix signs gets no
 * split (0): a share of a sum that cancels means nothing.
 */
export function otherSplit(opts: {
	rows: number;
	band: RowColumn;
	otherId: number;
	ids: RowColumn;
	values: RowColumn;
	selected: ReadonlySet<unknown> | null;
	decode: ArrayLike<unknown>;
}): Float32Array {
	const { rows, band, otherId, ids, values, selected, decode } = opts;
	const out = new Float32Array(rows);
	for (let row = 0; row < rows; row++) {
		if (Number(band.at(row)) !== otherId) continue;
		const memberIds = ids.at(row) as ArrayLike<number> | null;
		const memberValues = values.at(row) as ArrayLike<number> | null;
		if (!memberIds || !memberValues) continue;
		let total = 0;
		let picked = 0;
		let positive = false;
		let negative = false;
		for (let k = 0; k < memberIds.length; k++) {
			const v = memberValues[k];
			if (v > 0) positive = true;
			else if (v < 0) negative = true;
			total += v;
			if (selected?.has(decode[memberIds[k]])) picked += v;
		}
		if (positive && negative) continue;
		const share = selected == null ? 1 : total === 0 ? 0 : picked / total;
		out[row] = 1 + Math.min(1, Math.max(0, share));
	}
	return out;
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
