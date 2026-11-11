import {
	and as sqlAnd,
	isIn,
	isNotDistinct,
	literal,
	or,
	sql as sqlTag,
	type ExprNode
} from '@uwdata/mosaic-sql';

/**
 * A toggle's clause over its selected tuples: `IN` for one field, an `OR` of
 * `IS NOT DISTINCT FROM` tuples for several, so a NULL member matches NULL.
 *
 * The caller maps each field to an expression: its identity SQL against the
 * base table, or a preagg table's `__activeN` column. One builder serves both,
 * so a predicate is never rewritten after the fact.
 */
export function togglePredicate(exprs: ExprNode[], tuples: unknown[][]): ExprNode {
	if (exprs.length === 1) {
		// NULL is a category, but `IN (…, NULL)` never matches it: NULL = NULL is
		// not true. It goes beside the list as IS NULL instead.
		const values = tuples.map((t) => t[0]);
		const real = values.filter((v) => v !== null);
		const hasNull = real.length < values.length;
		const inList =
			real.length > 0
				? isIn(
						exprs[0],
						real.map((v) => literal(v))
					)
				: null;
		const isNull = hasNull ? isNotDistinct(exprs[0], literal(null)) : null;
		if (inList && isNull) return or([inList, isNull]);
		return inList ?? isNull ?? isIn(exprs[0], []);
	}
	const clauses = tuples.map((t) => sqlAnd(t.map((v, i) => isNotDistinct(exprs[i], literal(v)))));
	return clauses.length === 1 ? clauses[0] : or(clauses);
}

/**
 * Above this many ids, a selection over an id column is a bitmap, not an `IN`
 * list (see idBitmapPredicate). The crossover measured in DuckDB-WASM 1.30 lies
 * between 500 values (`IN`, 29 ms on 2 M rows) and the bitmap (26 ms).
 */
export const BITMAP_MIN_IDS = 256;

/**
 * `expr`'s id is one of `ids`, as one constant-size literal:
 * `get_bit('<bits>'::BIT, <index>) = 1`.
 *
 * Never `NOT IN`, whatever the selection's size: DuckDB evaluates it as a chain
 * of `<>`, 2.8 s on 2 M rows for 1 000 ids. And never a long `IN`, which it
 * spends most of its time parsing.
 *
 * Bit `id + 1` is set for each selected id; bit 0 is id -1 ("not in the dim
 * yet") and is never set; the last bit, `size + 1`, is a sentinel kept 0. The
 * index is clamped onto [0, sentinel], so an id appended to the dim after the
 * selection was made reads the sentinel (it was not selected: a snapshot), and
 * get_bit never sees an index out of range, which is an error rather than a 0.
 */
export function idBitmapPredicate(expr: ExprNode, ids: readonly number[], size: number): ExprNode {
	const bits = new Array<string>(size + 2).fill('0');
	for (const id of ids) if (id >= 0 && id < size) bits[id + 1] = '1';
	const sentinel = size + 1;
	return sqlTag`get_bit(${literal(bits.join(''))}::BIT, CAST(greatest(least(${expr} + 1, ${sentinel}), 0) AS INTEGER)) = 1` as unknown as ExprNode;
}
