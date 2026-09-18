/**
 * How a channel expression becomes an identity key.
 *
 * One derivation, in one place, because two things have to agree exactly and
 * neither can check the other: the key `CategoricalIdentity` names a dim after,
 * and the `sourceField` a scale is registered under. If they diverge the scale
 * looks up a dim that does not exist and the axis silently empties.
 *
 * It lived inside `MarkLifecycleV2` until the domain fetch needed it too. That
 * fetch was left running `SELECT DISTINCT` for expression-backed axes rather
 * than reading the dim — correct but redundant — specifically because routing it
 * through the dim would have meant a second copy of this logic, which is the
 * pattern that produced the `otherIdsByColumn` bug: a producer and a consumer
 * each internally consistent, agreeing by derivation rather than by identity.
 */

import { isNode, type ExprNode } from '@uwdata/mosaic-sql';
import { isBinExpression } from '$lib/sql/bin';
import { isAggregateExpression } from '@uwdata/mosaic-sql';
import { isWindowExpression } from '$lib/sql/expression-utils';
import type { IdentityField } from './categorical-identity';

/** Double any embedded quote so a name is safe inside "..." . */
function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * The identity key and value SQL for a channel, or null when it cannot be dimmed.
 *
 * A plain column name becomes a quoted identifier. A fixed SQL expression is
 * keyed on its own text and emitted verbatim (#197) — the two are one code
 * path, differing only in what is substituted for the value expression.
 *
 * Refused, and why each is refused rather than merely unsupported:
 *
 *  - **`bin()`** — bin edges move with the viewport, so the "same" value maps to
 *    a different bucket after a zoom. An id that changes meaning is not an
 *    identity, and the codebase already decided elsewhere that rebinned values
 *    get a pixel-space crossfade instead.
 *  - **aggregates and window functions** — not a row-level value, so there is
 *    nothing to group by or join a dim against.
 *
 * Null means the caller must say so rather than fall back: since the CASE path
 * for positional band channels was deleted there is nothing to fall back to.
 */
export function identityKeyFor(field: unknown): IdentityField | null {
	if (field == null) return null;
	if (typeof field === 'string') return field ? { key: field, sql: quote(field) } : null;

	// bin() first, and on its own line. An AutoBinNode is a plain class rather
	// than an ExprNode, so it also fails isNode() below — which made this check
	// unreachable in the form it was extracted from, and meant the rule this
	// exists for — a binned axis gets no identity, because its values move with
	// the viewport — was being enforced by accident. Checked first, it is the
	// clause that actually fires, and it keeps firing if AutoBinNode ever becomes
	// a real node.
	if (isBinExpression(field)) return null;
	if (!isNode(field)) return null;
	if (isAggregateExpression(field as ExprNode) || isWindowExpression(field as ExprNode)) {
		return null;
	}

	const sql = String(field);
	return sql ? { key: sql, sql } : null;
}
