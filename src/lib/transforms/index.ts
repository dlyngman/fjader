/**
 * Transform Pipeline for Mosaic-based visualizations
 *
 * Transforms are divided into two stages:
 * - SQL: Modify the Query AST (WHERE, HAVING, LIMIT, ORDER BY)
 * - JS: Process Arrow table results (topN, stack, dodge, normalize)
 *
 * SQL transforms must maintain flat queries (no CTEs) to preserve
 * Mosaic's PreAggregator optimization.
 */

import type { ExprNode, SelectQuery } from '@uwdata/mosaic-sql';
import * as d3 from 'd3-array';
import type { SqlTransform, JsTransform, MarkConfig, ScaleMap } from '$lib/types';

type Query = SelectQuery;

type DataRow = Record<string, unknown>;

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
// JS TRANSFORMS (Data Processors)
// =============================================================================

interface TopNOptions {
	by?: string;
	includeOthers?: boolean;
}

export function topN(n: number, options: TopNOptions = {}): JsTransform {
	return {
		stage: 'js',
		type: 'topN',
		apply(data: DataRow[], config: MarkConfig) {
			if (!data || data.length === 0) return data;

			const by = options.by || config.y;

			const sorted = [...data].sort(
				(a, b) => ((b[by!] as number) || 0) - ((a[by!] as number) || 0)
			);

			if (sorted.length <= n) {
				return sorted;
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

				return [...top, otherRow];
			}

			return top;
		},
		describe() {
			return `Top ${n}${options.includeOthers ? ' (with Others)' : ''}`;
		}
	};
}

interface StackOptions {
	direction?: 'vertical' | 'horizontal';
}

export function stack(options: StackOptions = {}): JsTransform {
	const { direction = 'vertical' } = options;

	return {
		stage: 'js',
		type: 'stack',
		apply(data: DataRow[], config: MarkConfig) {
			if (!data || data.length === 0) return data;

			const groupField = direction === 'vertical' ? config.x : config.y;
			const valueField = direction === 'vertical' ? config.y : config.x;

			const groups = d3.group(data, (d) => d[groupField!]);

			const stacked: DataRow[] = [];
			for (const [_category, items] of groups) {
				let offset = 0;
				for (const item of items) {
					const value = (item[valueField!] as number) || 0;

					if (direction === 'vertical') {
						stacked.push({ ...item, y0: offset, y1: offset + value });
					} else {
						stacked.push({ ...item, x0: offset, x1: offset + value });
					}

					offset += value;
				}
			}

			return stacked;
		},
		channels: direction === 'vertical' ? ['y0', 'y1'] : ['x0', 'x1']
	};
}

export function normalize(_options: Record<string, unknown> = {}): JsTransform {
	return {
		stage: 'js',
		type: 'normalize',
		apply(data: DataRow[], config: MarkConfig) {
			if (!data || data.length === 0) return data;

			const xField = config.x!;
			const yField = config.y!;

			const groups = d3.group(data, (d) => d[xField]);

			const normalized: DataRow[] = [];
			for (const [_x, items] of groups) {
				const total = d3.sum(items, (d) => (d[yField] as number) || 0);

				for (const item of items) {
					const value = (item[yField] as number) || 0;
					normalized.push({
						...item,
						[yField]: total > 0 ? (value / total) * 100 : 0,
						...(item.y0 !== undefined && {
							y0: total > 0 ? ((item.y0 as number) / total) * 100 : 0
						}),
						...(item.y1 !== undefined && {
							y1: total > 0 ? ((item.y1 as number) / total) * 100 : 0
						})
					});
				}
			}

			return normalized;
		},
		describe() {
			return 'Normalize to percentages';
		}
	};
}

interface DodgeOptions {
	bandwidth?: number;
}

export function dodge(options: DodgeOptions = {}): JsTransform {
	return {
		stage: 'js',
		type: 'dodge',
		apply(data: DataRow[], config: MarkConfig, scales?: ScaleMap) {
			if (!data || data.length === 0) return data;

			const xField = config.x!;

			const bandwidth = scales?.x?.bandwidth?.() || options.bandwidth || 20;

			const groups = d3.group(data, (d) => d[xField]);

			const dodged: DataRow[] = [];
			for (const [_x, items] of groups) {
				const offset = bandwidth / items.length;

				items.forEach((item, i) => {
					dodged.push({
						...item,
						x0: (item[xField] as number) + i * offset,
						x1: (item[xField] as number) + (i + 1) * offset
					});
				});
			}

			return dodged;
		},
		channels: ['x0', 'x1'],
		describe() {
			return 'Dodge by group';
		}
	};
}

export { TransformCompiler } from './TransformCompiler';
