import { and as sqlAnd, isIn, isNotDistinct, literal, or, type ExprNode } from '@uwdata/mosaic-sql';

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
		return isIn(
			exprs[0],
			tuples.map((t) => literal(t[0]))
		);
	}
	const clauses = tuples.map((t) => sqlAnd(t.map((v, i) => isNotDistinct(exprs[i], literal(v)))));
	return clauses.length === 1 ? clauses[0] : or(clauses);
}
