/**
 * Bidirectional conversion between FieldSpec (JSON) and FieldRef (runtime).
 *
 * resolveFieldSpec: spec → runtime (used by PlotFromSpec)
 * fieldRefToSpec:   runtime → spec (used by spec export)
 */

import {
	count,
	sum,
	avg,
	min,
	max,
	median,
	column,
	isNode,
	sql,
	frameRows,
	preceding,
	following,
	currentRow
} from '@uwdata/mosaic-sql';
import { bin, isBinExpression, type AutoBinNode } from '$lib/sql/bin';
import type { FieldRef } from '$lib/types';
import type {
	FieldSpec,
	AggregateFieldSpec,
	BinFieldSpec,
	WindowFieldSpec,
	RawSqlFieldSpec
} from './types';

const AGG_PATTERN = /^(count|sum|avg|min|max|median)\(([^)]*)\)$/;

const AGG_FUNCTIONS = { count, sum, avg, min, max, median } as const;

/** Resolved field: a column name, expression node, or auto-bin node. */
export type ResolvedField = FieldRef | AutoBinNode;

/**
 * Resolve a FieldSpec from a JSON spec into a value that DivePlot marks accept.
 *
 * - Plain string without parens → column name (pass through)
 * - `"count()"` / `"sum(field)"` → Mosaic aggregate expression node
 * - `{ aggregate: "count" }` → same, object form
 * - `{ bin: "field", steps: 30 }` → AutoBinNode from $lib/sql/bin
 */
export function resolveFieldSpec(spec: FieldSpec): ResolvedField {
	// Numbers are constants (e.g. r=3), pass through unchanged
	if (typeof spec === 'number') return spec as unknown as ResolvedField;
	if (typeof spec === 'string') {
		const match = spec.match(AGG_PATTERN);
		if (match) {
			const fnName = match[1] as keyof typeof AGG_FUNCTIONS;
			const argStr = match[2].trim();
			return resolveAggregate(fnName, argStr || undefined);
		}
		// Plain column name
		return spec;
	}

	if (isAggregateFieldSpec(spec)) {
		return resolveAggregate(spec.aggregate, spec.field);
	}

	if (isBinFieldSpec(spec)) {
		return bin(spec.bin, spec.steps != null ? { steps: spec.steps } : {});
	}

	if (isWindowFieldSpec(spec)) {
		return resolveWindowSpec(spec);
	}

	if (isRawSqlFieldSpec(spec)) {
		return rawSql(spec.sql) as unknown as ResolvedField;
	}

	// Fallback: treat as string
	return String(spec);
}

function resolveAggregate(fnName: keyof typeof AGG_FUNCTIONS, fieldName?: string): ResolvedField {
	const fn = AGG_FUNCTIONS[fnName];
	if (fnName === 'count') {
		return fieldName ? (fn as typeof count)(column(fieldName)) : (fn as typeof count)();
	}
	if (!fieldName) {
		throw new Error(`Aggregate "${fnName}" requires a field argument`);
	}
	return fn(column(fieldName));
}

function isAggregateFieldSpec(spec: FieldSpec): spec is AggregateFieldSpec {
	return typeof spec === 'object' && 'aggregate' in spec;
}

function isBinFieldSpec(spec: FieldSpec): spec is BinFieldSpec {
	return typeof spec === 'object' && 'bin' in spec;
}

function isWindowFieldSpec(spec: FieldSpec): spec is WindowFieldSpec {
	return typeof spec === 'object' && 'window' in spec;
}

function isRawSqlFieldSpec(spec: FieldSpec): spec is RawSqlFieldSpec {
	return typeof spec === 'object' && 'sql' in spec;
}

/** Convert a raw SQL string into a Mosaic SQL expression node. */
function rawSql(str: string) {
	const strings = Object.assign([str], { raw: [str] }) as TemplateStringsArray;
	return sql(strings);
}

/**
 * Convert a frame boundary integer to a Mosaic frame boundary.
 * Negative = preceding(|n|), 0 = currentRow(), positive = following(n).
 */
function frameBoundary(n: number) {
	if (n < 0) return preceding(-n);
	if (n > 0) return following(n);
	return currentRow();
}

function resolveWindowSpec(spec: WindowFieldSpec): ResolvedField {
	const fnName = spec.window as keyof typeof AGG_FUNCTIONS;
	const fn = AGG_FUNCTIONS[fnName];
	if (!fn) throw new Error(`Unknown window aggregate: "${spec.window}"`);

	// Build the aggregate base
	let base;
	if (fnName === 'count') {
		base = spec.field ? (fn as typeof count)(column(spec.field)) : (fn as typeof count)();
	} else {
		if (!spec.field) throw new Error(`Window aggregate "${fnName}" requires a field`);
		base = fn(column(spec.field));
	}

	// Chain window clauses
	let windowed = base;
	if (spec.partitionBy) {
		windowed = windowed.partitionby(spec.partitionBy);
	}
	if (spec.orderBy) {
		windowed = windowed.orderby(spec.orderBy);
	}
	if (spec.frame) {
		const [start, end] = spec.frame;
		windowed = windowed.frame(frameRows([frameBoundary(start), frameBoundary(end)]));
	}

	return windowed as unknown as ResolvedField;
}

// =============================================================================
// Runtime → Spec (inverse of resolveFieldSpec)
// =============================================================================

/** Known aggregate function names (same set as AGG_FUNCTIONS above). */
const AGG_NAMES = new Set(Object.keys(AGG_FUNCTIONS));

/**
 * Convert a runtime FieldRef (or AutoBinNode) back to a FieldSpec for JSON export.
 *
 * - string → pass through (column name)
 * - number → pass through (constant)
 * - AutoBinNode → { bin, steps? }
 * - AggregateNode → "count()" / "sum(field)" shorthand
 * - Other ExprNode → toString() fallback
 */
export function fieldRefToSpec(value: unknown): FieldSpec | null {
	if (value == null) return null;
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return value as unknown as FieldSpec;
	if (typeof value === 'function') return null; // can't serialize functions

	// AutoBinNode → { bin, steps? }
	if (isBinExpression(value)) {
		const fieldName = typeof value.field === 'string' ? value.field : String(value.field);
		const spec: BinFieldSpec = { bin: fieldName };
		if (value.options.steps != null) spec.steps = value.options.steps;
		return spec;
	}

	// Mosaic ExprNode — check for aggregate
	if (isNode(value)) {
		const node = value as { type?: string; name?: string; args?: unknown[] };
		if (node.type === 'AGGREGATE' && node.name && AGG_NAMES.has(node.name.toLowerCase())) {
			const fnName = node.name.toLowerCase();
			if (fnName === 'count' && (!node.args || node.args.length === 0)) {
				return 'count()';
			}
			// Extract field name from first arg (ColumnNameRefNode)
			const firstArg = node.args?.[0] as { column?: string } | undefined;
			const argName = firstArg?.column;
			return argName ? `${fnName}(${argName})` : `${fnName}()`;
		}
		// Fallback: produce SQL string
		return value.toString();
	}

	return null;
}
