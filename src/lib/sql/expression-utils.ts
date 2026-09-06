import { isNode } from '@uwdata/mosaic-sql';

/** Check if an AST node is a window expression (e.g. sum('x').partitionby(...).orderby(...)). */
export function isWindowExpression(node: unknown): boolean {
	return isNode(node) && (node as { type: string }).type === 'WINDOW';
}

/**
 * Check if a node is a verbatim SQL fragment (built with mosaic's `sql` tag)
 * whose text contains a window function.
 *
 * Structural analysis cannot see inside a verbatim fragment, and mosaic's
 * `isAggregateExpression` collapses two very different cases onto the same
 * return value: it walks such a node, spots `) over ` in the lowercased text
 * and stops *without setting a flag* — returning 0, exactly what a provably
 * plain column ref returns. Callers that read 0 as "pure dimension" then put a
 * window expression into GROUP BY, which is invalid: windows are evaluated
 * after grouping, so the database rejects the query.
 *
 * This distinguishes the two so callers can bail instead of emitting bad SQL.
 * The text handling mirrors mosaic's walker (strip scalar-subquery content,
 * then look for `) over `) so the two agree on what counts as a window.
 *
 * Note this is deliberately narrow: it does not try to detect verbatim
 * DISTINCT or other unsupported constructs, only the case that silently
 * produces an invalid GROUP BY.
 */
export function isVerbatimWindowExpression(node: unknown): boolean {
	if (!isNode(node)) return false;
	const type = (node as { type: string }).type;
	if (type !== 'FRAGMENT' && type !== 'VERBATIM') return false;

	let s = `${node}`.toLowerCase();
	const sub = s.indexOf('(select ');
	if (sub >= 0) s = s.slice(0, sub);
	return s.includes(') over ');
}
