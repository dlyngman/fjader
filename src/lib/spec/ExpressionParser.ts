/**
 * Converts FieldSpec values from JSON specs into FieldRef values
 * that mark components accept (column strings or Mosaic SQL expression nodes).
 */

import { count, sum, avg, min, max, median, column } from '@uwdata/mosaic-sql';
import { bin, type AutoBinNode } from '$lib/sql/bin';
import type { FieldRef } from '$lib/types';
import type { FieldSpec, AggregateFieldSpec, BinFieldSpec } from './types';

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
