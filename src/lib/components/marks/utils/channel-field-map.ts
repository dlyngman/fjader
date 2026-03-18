import { isNode, isColumnRef, isAggregateExpression } from '@uwdata/mosaic-sql';
import { isBinExpression } from '$lib/sql/bin';
import { isWindowExpression } from '$lib/sql/expression-utils';
import type { FieldRef } from '$lib/types';

/**
 * Extract the underlying field name from a select value.
 *
 * - String: the value itself (e.g., "species")
 * - AutoBinNode: the binned field (e.g., bin("weight") → "weight")
 * - AggregateNode: the first column argument (e.g., max("revenue") → "revenue")
 * - ColumnRefNode: the column name (e.g., sqlColumn("weight") → "weight")
 * - Numbers / other: null (caller should fall back to channel name)
 */
export function extractFieldName(value: unknown): string | null {
	if (typeof value === 'string') return value;

	// AutoBinNode — .field is a string or ExprNode
	if (isBinExpression(value)) {
		return typeof value.field === 'string' ? value.field : value.stats.column;
	}

	// AggregateNode — inner column if available, else function name (e.g., "count")
	if (isNode(value) && isAggregateExpression(value)) {
		const agg = value as { args?: unknown[]; name?: string };
		const arg = agg.args?.[0];
		if (arg && isColumnRef(arg)) return (arg as { column: string }).column;
		if (agg.name) return agg.name;
	}

	// ColumnRefNode
	if (isColumnRef(value)) return (value as { column: string }).column;

	// FunctionNode — recursively find the first column ref in args
	// (e.g., dateMonthDay("date") → make_date(2012, month("date"), day("date")) → "date")
	if (isNode(value)) {
		const args = (value as { args?: unknown[] }).args;
		if (args) {
			for (const arg of args) {
				const name = extractFieldName(arg);
				if (name) return name;
			}
		}
	}

	return null;
}

/**
 * Build a mapping from channel names (SQL aliases) to human-readable field names.
 *
 * For string fields: channel → field name (e.g., "fill" → "species")
 * For expression nodes: channel → extracted field name (e.g., "y" → "revenue" from max("revenue"))
 * Falls back to channel name when field cannot be extracted (e.g., numeric constants).
 *
 * This is the single source of truth for channel→field resolution, used by
 * the tooltip system and any future display consumer.
 */
export function buildChannelFieldMap(select: Record<string, unknown>): Record<string, string> {
	const map: Record<string, string> = {};
	for (const [channel, value] of Object.entries(select)) {
		if (value == null) continue;
		map[channel] = extractFieldName(value) ?? channel;
	}
	return map;
}

// ---------------------------------------------------------------------------
// Expression label helper
// ---------------------------------------------------------------------------

/**
 * Build a descriptive label for an expression node, e.g. "min(value)", "count()".
 * Used as both the SQL alias and the tooltip display name.
 */
export function buildExpressionLabel(value: unknown): string | null {
	if (!isNode(value)) return null;

	if (isAggregateExpression(value) || isWindowExpression(value)) {
		const node = value as { name?: string; args?: unknown[] };
		const fnName = node.name ?? 'expr';
		const arg = node.args?.[0];
		const fieldName = arg && isColumnRef(arg) ? (arg as { column: string }).column : null;
		return fieldName ? `${fnName}(${fieldName})` : `${fnName}()`;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Tip resolution
// ---------------------------------------------------------------------------

export interface ResolvedTip {
	extraSelect: Record<string, unknown>;
	displayFields: string[] | null;
}

/**
 * Resolve a `tip` prop into extra SELECT columns and an ordered display field list.
 *
 * Each tip entry is resolved as:
 * - `'*'` → all channel fields in select order
 * - Channel name ('x', 'y', 'fill', …) → that channel's field
 * - Field name already in a channel → included directly
 * - Unknown string → extra DB column to fetch (added to extraSelect)
 * - Expression node (aggregate/window) → tooltip-only, NOT added to extraSelect.
 *   These are injected lazily into the tooltip temp table query by MarkLifecycle.
 *
 * Returns `displayFields: null` when tip is unset (show-all default).
 */
export function resolveTip(
	tip: (FieldRef | '*')[] | false | undefined,
	channelSelect: Record<string, unknown>
): ResolvedTip {
	if (!tip) return { extraSelect: {}, displayFields: null };

	const fieldMap = buildChannelFieldMap(channelSelect);
	const knownFields = new Set(Object.values(fieldMap));
	const extraSelect: Record<string, unknown> = {};
	const displayFields: string[] = [];

	for (let i = 0; i < tip.length; i++) {
		const entry = tip[i];

		if (entry === '*') {
			for (const field of Object.values(fieldMap)) {
				if (!displayFields.includes(field)) displayFields.push(field);
			}
			continue;
		}

		// Channel name shorthand (e.g., 'x' → 'bill_length')
		// For range marks: 'x' falls back to 'x2', 'y' falls back to 'y2'
		if (typeof entry === 'string') {
			let channel: string | null = null;
			if (entry in channelSelect) {
				channel = entry;
			} else if ((entry === 'x' || entry === 'y') && `${entry}2` in channelSelect) {
				channel = `${entry}2`;
			}
			if (channel) {
				const field = fieldMap[channel] ?? channel;
				if (!displayFields.includes(field)) displayFields.push(field);
				continue;
			}
		}

		// Field name already in a channel (e.g., 'species' when fill='species')
		if (typeof entry === 'string' && knownFields.has(entry)) {
			if (!displayFields.includes(entry)) displayFields.push(entry);
			continue;
		}

		// Expression node (aggregate/window) — tooltip-only, handled by MarkLifecycle.
		// Add its label to displayFields but NOT to extraSelect (avoids polluting main query).
		const exprLabel = buildExpressionLabel(entry);
		if (exprLabel) {
			if (!displayFields.includes(exprLabel)) displayFields.push(exprLabel);
			continue;
		}

		// Extra string field — add to select and display list
		const key = typeof entry === 'string' ? entry : (extractFieldName(entry) ?? `_tip_${i}`);
		if (!(key in channelSelect)) extraSelect[key] = entry;
		if (!displayFields.includes(key)) displayFields.push(key);
	}

	return { extraSelect, displayFields };
}
