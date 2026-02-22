/**
 * Transform Pipeline for Mosaic-based visualizations
 *
 * Transforms are divided into two stages:
 * - SQL: Modify the Query AST (WHERE, HAVING, LIMIT, ORDER BY)
 * - JS: Process data via the DataAccessor interface (zero-copy on Arrow data)
 *
 * SQL transforms must maintain flat queries (no CTEs) to preserve
 * Mosaic's PreAggregator optimization.
 */

import type { ExprNode, SelectQuery } from '@uwdata/mosaic-sql';
import type { SqlTransform, JsTransform, MarkConfig, ScaleMap } from '$lib/types';
import {
	ObjectDataAccessor,
	type DataAccessor
} from '$lib/data/DataAccessor';

type Query = SelectQuery;

type DataRow = Record<string, unknown>;

// =============================================================================
// Helpers
// =============================================================================

/** Convert any DataAccessor to plain row objects (for transforms that need row-level ops). */
function accessorToRows(data: DataAccessor): DataRow[] {
	const cols = data.columnNames;
	const arrays = cols.map((c) => data.getColumn(c));
	const rows: DataRow[] = [];
	for (let i = 0; i < data.length; i++) {
		const row: DataRow = {};
		for (let j = 0; j < cols.length; j++) {
			row[cols[j]] = arrays[j]?.[i] ?? null;
		}
		rows.push(row);
	}
	return rows;
}

// =============================================================================
// SQL TRANSFORMS (Query Modifiers)
// =============================================================================

export function filter(condition: ExprNode): SqlTransform {
	return {
		stage: 'sql',
		type: 'filter',
		apply(query: Query) {
			return query.where(condition);
		},
		describe() {
			return `Filter: ${condition.toString()}`;
		}
	};
}

export function having(condition: ExprNode): SqlTransform {
	return {
		stage: 'sql',
		type: 'having',
		apply(query: Query) {
			return query.having(condition);
		},
		describe() {
			return `Having: ${condition.toString()}`;
		}
	};
}

export function limit(n: number): SqlTransform {
	return {
		stage: 'sql',
		type: 'limit',
		apply(query: Query) {
			return query.limit(n);
		},
		describe() {
			return `Limit: ${n}`;
		}
	};
}

export function orderby(...expressions: ExprNode[]): SqlTransform {
	return {
		stage: 'sql',
		type: 'orderby',
		apply(query: Query) {
			return query.orderby(...expressions);
		},
		describe() {
			return `Order by: ${expressions.map((e) => e.toString()).join(', ')}`;
		}
	};
}

// =============================================================================
// JS TRANSFORMS (DataAccessor → DataAccessor)
// =============================================================================

// -----------------------------------------------------------------------------
// topN — sorts and takes top N rows (row-level operation, converts to objects)
// -----------------------------------------------------------------------------

interface TopNOptions {
	by?: string;
	includeOthers?: boolean;
}

export function topN(n: number, options: TopNOptions = {}): JsTransform {
	return {
		stage: 'js',
		type: 'topN',
		apply(data: DataAccessor, config: MarkConfig) {
			if (data.length === 0) return data;

			const rows = accessorToRows(data);
			const by = options.by || config.y;

			const sorted = rows.sort(
				(a, b) => ((b[by!] as number) || 0) - ((a[by!] as number) || 0)
			);

			if (sorted.length <= n) {
				return new ObjectDataAccessor(sorted);
			}

			const top = sorted.slice(0, n);

			if (options.includeOthers) {
				const others = sorted.slice(n);
				const otherRow: DataRow = { [config.x!]: 'Other' };

				for (const key of Object.keys(others[0])) {
					if (typeof others[0][key] === 'number') {
						otherRow[key] = others.reduce((sum, d) => sum + ((d[key] as number) || 0), 0);
					}
				}

				return new ObjectDataAccessor([...top, otherRow]);
			}

			return new ObjectDataAccessor(top);
		},
		describe() {
			return `Top ${n}${options.includeOthers ? ' (with Others)' : ''}`;
		}
	};
}

// -----------------------------------------------------------------------------
// stackY / stackX — cumulative offset stacking (typed array native)
// -----------------------------------------------------------------------------

type StackOffset = null | 'expand' | 'center';

interface StackYOptions {
	offset?: StackOffset;
}

interface StackXOptions {
	offset?: StackOffset;
}

/**
 * Stack vertically: groups on x, accumulates y values into y0/y1.
 * Follows Observable Plot's stackY convention.
 * Data must be sorted by (groupField, series) for correct results.
 */
export function stackY(options: StackYOptions = {}): JsTransform {
	return {
		stage: 'js',
		type: 'stack',
		channels: ['y0', 'y1'],
		apply(data: DataAccessor, config: MarkConfig) {
			return computeStack(data, config.x!, config.y!, 'y0', 'y1', options.offset ?? null);
		},
		describe() {
			const parts = ['Stack Y'];
			if (options.offset) parts.push(`(${options.offset})`);
			return parts.join(' ');
		}
	};
}

/**
 * Stack horizontally: groups on y, accumulates x values into x0/x1.
 * Follows Observable Plot's stackX convention.
 */
export function stackX(options: StackXOptions = {}): JsTransform {
	return {
		stage: 'js',
		type: 'stack',
		channels: ['x0', 'x1'],
		apply(data: DataAccessor, config: MarkConfig) {
			return computeStack(data, config.y!, config.x!, 'x0', 'x1', options.offset ?? null);
		},
		describe() {
			const parts = ['Stack X'];
			if (options.offset) parts.push(`(${options.offset})`);
			return parts.join(' ');
		}
	};
}

/**
 * Core stacking computation on DataAccessor columns.
 *
 * Single O(n) pass: detects group boundaries in the sorted group column,
 * accumulates value offsets, writes lo/hi Float32Arrays, applies offset mode.
 */
/**
 * Core stacking computation on DataAccessor columns.
 *
 * Uses Map-based accumulation so it works regardless of data sort order.
 * Connected topology marks (areas/lines) arrive sorted by series-first
 * (ORDER BY series, x), not x-first, so sequential group boundary
 * detection fails. The Map approach handles any ordering in O(n).
 */
function computeStack(
	data: DataAccessor,
	groupField: string,
	valueField: string,
	loName: string,
	hiName: string,
	offset: StackOffset
): DataAccessor {
	const n = data.length;
	if (n === 0) return data;

	const groupCol = data.getColumn(groupField);
	const valueCol = data.getColumn(valueField);
	if (!groupCol || !valueCol) return data;

	const lo = new Float32Array(n);
	const hi = new Float32Array(n);

	// Map-based accumulation: works regardless of sort order
	const cumulatives = new Map<unknown, number>();

	for (let i = 0; i < n; i++) {
		const group = groupCol[i];
		const cumulative = cumulatives.get(group) || 0;
		const value = Number(valueCol[i]) || 0;
		lo[i] = cumulative;
		hi[i] = cumulative + value;
		cumulatives.set(group, cumulative + value);
	}

	// Apply offset using group totals (cumulatives map now holds totals)
	if (offset === 'expand') {
		for (let i = 0; i < n; i++) {
			const total = cumulatives.get(groupCol[i]) || 0;
			if (total !== 0) {
				lo[i] /= total;
				hi[i] /= total;
			}
		}
	} else if (offset === 'center') {
		for (let i = 0; i < n; i++) {
			const total = cumulatives.get(groupCol[i]) || 0;
			lo[i] -= total / 2;
			hi[i] -= total / 2;
		}
	}

	return data.withOverlays({ [loName]: lo, [hiName]: hi });
}

/**
 * Legacy stack() — backward-compatible wrapper.
 * Prefer stackY() / stackX() for new code.
 */
interface LegacyStackOptions {
	direction?: 'vertical' | 'horizontal';
}

export function stack(options: LegacyStackOptions = {}): JsTransform {
	const { direction = 'vertical' } = options;
	if (direction === 'horizontal') return stackX();
	return stackY();
}

// -----------------------------------------------------------------------------
// normalize — rescale values to percentages within each group
// -----------------------------------------------------------------------------

export function normalize(_options: Record<string, unknown> = {}): JsTransform {
	return {
		stage: 'js',
		type: 'normalize',
		apply(data: DataAccessor, config: MarkConfig) {
			if (data.length === 0) return data;

			const n = data.length;
			const groupField = config.x!;
			const valueField = config.y!;

			const groupCol = data.getColumn(groupField);
			const valueCol = data.getColumn(valueField);
			if (!groupCol || !valueCol) return data;

			// Check if stacked (y0/y1 overlays exist)
			const y0Col = data.getColumn('y0');
			const y1Col = data.getColumn('y1');
			const isStacked = y0Col !== null && y1Col !== null;

			if (isStacked) {
				// Build per-group totals (max y1 = cumulative total at each group position)
				const totals = new Map<unknown, number>();
				for (let i = 0; i < n; i++) {
					const group = groupCol[i];
					const y1Val = Number(y1Col[i]);
					const current = totals.get(group) ?? -Infinity;
					if (y1Val > current) totals.set(group, y1Val);
				}

				// Normalize stacked data: scale y0/y1 by group total
				const newY0 = new Float32Array(n);
				const newY1 = new Float32Array(n);
				const newValue = new Float32Array(n);

				for (let i = 0; i < n; i++) {
					const total = totals.get(groupCol[i]) || 0;
					if (total > 0) {
						newY0[i] = (Number(y0Col[i]) / total) * 100;
						newY1[i] = (Number(y1Col[i]) / total) * 100;
						newValue[i] = (Number(valueCol[i]) / total) * 100;
					}
				}

				return data.withOverlays({ y0: newY0, y1: newY1, [valueField]: newValue });
			} else {
				// Build per-group totals
				const totals = new Map<unknown, number>();
				for (let i = 0; i < n; i++) {
					const group = groupCol[i];
					totals.set(group, (totals.get(group) || 0) + (Number(valueCol[i]) || 0));
				}

				// Normalize unstacked data: scale values by group total
				const newValue = new Float32Array(n);
				for (let i = 0; i < n; i++) {
					const total = totals.get(groupCol[i]) || 0;
					newValue[i] = total > 0 ? ((Number(valueCol[i]) || 0) / total) * 100 : 0;
				}

				return data.withOverlays({ [valueField]: newValue });
			}
		},
		describe() {
			return 'Normalize to percentages';
		}
	};
}

// -----------------------------------------------------------------------------
// dodge — offset items within groups (row-level operation)
// -----------------------------------------------------------------------------

interface DodgeOptions {
	bandwidth?: number;
}

export function dodge(options: DodgeOptions = {}): JsTransform {
	return {
		stage: 'js',
		type: 'dodge',
		apply(data: DataAccessor, config: MarkConfig, scales?: ScaleMap) {
			if (data.length === 0) return data;

			const n = data.length;
			const xField = config.x!;
			const xCol = data.getColumn(xField);
			if (!xCol) return data;

			const bandwidth = scales?.x?.bandwidth?.() || options.bandwidth || 20;

			const x0 = new Float32Array(n);
			const x1 = new Float32Array(n);

			// Detect groups and compute dodge offsets
			let groupStart = 0;
			for (let i = 0; i <= n; i++) {
				if (i === n || (i > 0 && xCol[i] !== xCol[i - 1])) {
					// Process group [groupStart, i)
					const groupSize = i - groupStart;
					const offset = bandwidth / groupSize;
					const xVal = Number(xCol[groupStart]) || 0;
					for (let j = groupStart; j < i; j++) {
						const idx = j - groupStart;
						x0[j] = xVal + idx * offset;
						x1[j] = xVal + (idx + 1) * offset;
					}
					groupStart = i;
				}
			}

			return data.withOverlays({ x0, x1 });
		},
		channels: ['x0', 'x1'],
		describe() {
			return 'Dodge by group';
		}
	};
}

export { TransformCompiler } from './TransformCompiler';
