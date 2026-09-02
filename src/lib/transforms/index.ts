/**
 * Transform Pipeline for Mosaic-based visualizations
 *
 * Transforms are divided into two stages:
 * - SQL: Modify the Query AST (WHERE, HAVING, LIMIT, ORDER BY, CTE wrapping)
 * - JS: Process data via the DataAccessor interface (zero-copy on Arrow data)
 */

import { Query, column, sql as sqlTag } from '@uwdata/mosaic-sql';
import type { ExprNode, SelectQuery } from '@uwdata/mosaic-sql';
import type { SqlTransform, JsTransform, Transform, MarkConfig, ScaleMap } from '$lib/types';
import { ColumnDataAccessor, type DataAccessor } from '$lib/data/DataAccessor';

// =============================================================================
// SQL TRANSFORMS (Query Modifiers)
// =============================================================================

export function filter(condition: ExprNode): SqlTransform {
	return {
		stage: 'sql',
		type: 'filter',
		spec: { transform: 'filter', condition: condition.toString() },
		apply(query: SelectQuery) {
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
		spec: { transform: 'having', condition: condition.toString() },
		apply(query: SelectQuery) {
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
		spec: { transform: 'limit', value: n },
		apply(query: SelectQuery) {
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
		spec: { transform: 'orderby', fields: expressions.map((e) => e.toString()) },
		apply(query: SelectQuery) {
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
// topN — filter to top N categories by aggregate value
//
// SQL path (default): CTE wrapping with ROW_NUMBER / LIMIT ranking.
// JS path (engine: 'js'): post-query DataAccessor processing.
// includeOthers only supported on JS path.
// -----------------------------------------------------------------------------

interface TopNOptions {
	/** Value channel to rank by. Default: the mark's value axis (y, or x for barx). */
	by?: string;
	includeOthers?: boolean;
	/** Force JS execution path. Default: SQL. */
	engine?: 'sql' | 'js';
}

export function topN(n: number, options: TopNOptions & { engine: 'js' }): JsTransform;
export function topN(n: number, options: TopNOptions & { includeOthers: true }): JsTransform;
export function topN(n: number, options?: TopNOptions): SqlTransform;
export function topN(n: number, options: TopNOptions = {}): SqlTransform | JsTransform {
	// includeOthers requires JS path (complex aggregation not yet in SQL)
	if (options.includeOthers || options.engine === 'js') {
		return topNJS(n, options);
	}
	return topNSQL(n, options);
}

/** Output aliases of a SelectQuery (the column names its result exposes). */
function getSelectAliases(query: SelectQuery): string[] {
	return query._select.map((s) => s.alias).filter(Boolean);
}

/** Build a passthrough select: all aliases as column refs. */
function passthroughSelect(aliases: string[]): Record<string, ExprNode> {
	const sel: Record<string, ExprNode> = {};
	for (const a of aliases) sel[a] = column(a);
	return sel;
}

/**
 * Resolve the value/band/series aliases for topN from the mark config,
 * validated against the query's own select list. Mirrors the JS path:
 * value axis is y for vertical marks, x for horizontal (barx); the mark
 * lifecycle has already resolved y → y2 etc. for extent-based marks.
 */
function resolveTopNColumns(
	aliases: string[],
	options: TopNOptions,
	config: MarkConfig | undefined
): { by: string; band: string; series: string | null } {
	const isHorizontal = config?.markType === 'barx';
	const by = options.by ?? (isHorizontal ? config?.x : config?.y);
	const band = isHorizontal ? config?.y : config?.x;
	const fill = config?.fill;
	const series = typeof fill === 'string' && aliases.includes(fill) ? fill : null;

	if (!by || !aliases.includes(by)) {
		throw new Error(
			`topN: value column "${by ?? '(none)'}" not in query select [${aliases.join(', ')}]`
		);
	}
	if (!band || !aliases.includes(band)) {
		throw new Error(
			`topN: band column "${band ?? '(none)'}" not in query select [${aliases.join(', ')}]`
		);
	}
	return { by, band, series };
}

function topNSQL(n: number, options: TopNOptions): SqlTransform {
	return {
		stage: 'sql',
		type: 'topN',
		spec: { transform: 'topN', n, ...(options.by ? { by: options.by } : {}) },
		apply(query: SelectQuery, config?: MarkConfig) {
			const aliases = getSelectAliases(query);
			const { by, band, series } = resolveTopNColumns(aliases, options, config);

			if (series) {
				// Grouped: compute total per band category, take top N, filter.
				// Ranks categories by SUM(value) across all series, then keeps
				// all series rows for the winning categories.
				const topCatsQuery = Query.from({ __topn_base: query })
					.select({ [band]: column(band) })
					.groupby(column(band))
					.orderby(sqlTag`SUM(${column(by)}) DESC`)
					.limit(n);

				return Query.from({ __topn_src: query })
					.select(passthroughSelect(aliases))
					.where(sqlTag`${column(band)} IN (${topCatsQuery})`);
			}

			// Simple: rank rows by value, filter to top N.
			const ranked = Query.from({ __topn_base: query }).select({
				...passthroughSelect(aliases),
				__topn_rank: sqlTag`ROW_NUMBER() OVER (ORDER BY ${column(by)} DESC)`
			});

			return Query.from({ __topn: ranked })
				.select(passthroughSelect(aliases))
				.where(sqlTag`"__topn_rank" <= ${n}`);
		},
		describe() {
			return `Top ${n} (SQL)`;
		}
	};
}

function topNJS(n: number, options: TopNOptions): JsTransform {
	return {
		stage: 'js',
		type: 'topN',
		spec: {
			transform: 'topN',
			n,
			...(options.by ? { by: options.by } : {}),
			...(options.includeOthers ? { includeOthers: true } : {})
		},
		apply(data: DataAccessor, config: MarkConfig) {
			if (data.length === 0) return data;

			// Value axis: x for horizontal marks (barx), y for vertical (bary, default)
			const isHorizontal = config.markType === 'barx';
			const valueField = (options.by || (isHorizontal ? config.x : config.y)) as string | undefined;
			const bandField = (isHorizontal ? config.y : config.x) as string | undefined;
			const seriesField = config.fill as string | undefined;

			if (!valueField || !bandField) return data;
			const valueCol = data.getColumn(valueField);
			const bandColData = data.getColumn(bandField);
			if (!valueCol || !bandColData) return data;

			const seriesCol = seriesField ? data.getColumn(seriesField) : null;
			if (seriesCol) {
				return topNGrouped(
					data,
					n,
					valueCol,
					bandColData,
					bandField,
					seriesCol,
					options,
					valueField
				);
			}

			// Simple path: no series column, rank individual rows
			if (data.length <= n) return data;
			return topNSimple(data, n, valueCol, bandField, options);
		},
		describe() {
			return `Top ${n}${options.includeOthers ? ' (with Others)' : ''} (JS)`;
		}
	};
}

/** topN without series: rank and gather individual rows. */
function topNSimple(
	data: DataAccessor,
	n: number,
	valueCol: ArrayLike<unknown>,
	bandField: string,
	options: TopNOptions
): DataAccessor {
	const indices = Array.from({ length: data.length }, (_, i) => i);
	indices.sort((a, b) => (Number(valueCol[b]) || 0) - (Number(valueCol[a]) || 0));

	const topIndices = indices.slice(0, n);
	const outLen = options.includeOthers ? n + 1 : n;
	const columns: Record<string, Float32Array | unknown[]> = {};

	for (const colName of data.columnNames) {
		const src = data.getColumn(colName);
		if (!src) continue;

		if (src instanceof Float32Array) {
			const dst = new Float32Array(outLen);
			for (let i = 0; i < n; i++) dst[i] = src[topIndices[i]];
			if (options.includeOthers) {
				let sum = 0;
				for (let i = n; i < indices.length; i++) sum += src[indices[i]];
				dst[n] = sum;
			}
			columns[colName] = dst;
		} else {
			const dst: unknown[] = topIndices.map((i) => src[i]);
			if (options.includeOthers) {
				dst.push(colName === bandField ? 'Other' : null);
			}
			columns[colName] = dst;
		}
	}

	return new ColumnDataAccessor(columns, outLen);
}

/** topN with series: rank categories by total across all series, keep all series rows. */
function topNGrouped(
	data: DataAccessor,
	n: number,
	valueCol: ArrayLike<unknown>,
	bandColData: ArrayLike<unknown>,
	bandField: string,
	seriesCol: ArrayLike<unknown>,
	options: TopNOptions,
	valueField: string
): DataAccessor {
	// Sum values per category to rank them
	const categoryTotals = new Map<unknown, number>();
	for (let i = 0; i < data.length; i++) {
		const cat = bandColData[i];
		categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + (Number(valueCol[i]) || 0));
	}

	// Rank categories descending by total
	const ranked = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);
	const topCategories = new Set(ranked.slice(0, n).map(([cat]) => cat));

	// Collect row indices for top categories and excluded categories
	const keepIndices: number[] = [];
	const excludeIndices: number[] = [];
	for (let i = 0; i < data.length; i++) {
		if (topCategories.has(bandColData[i])) {
			keepIndices.push(i);
		} else {
			excludeIndices.push(i);
		}
	}

	if (!options.includeOthers) {
		// Simple: gather rows for top N categories
		const columns: Record<string, Float32Array | unknown[]> = {};
		for (const colName of data.columnNames) {
			const src = data.getColumn(colName);
			if (!src) continue;
			if (src instanceof Float32Array) {
				const dst = new Float32Array(keepIndices.length);
				for (let i = 0; i < keepIndices.length; i++) dst[i] = src[keepIndices[i]];
				columns[colName] = dst;
			} else {
				columns[colName] = keepIndices.map((i) => src[i]);
			}
		}
		return new ColumnDataAccessor(columns, keepIndices.length);
	}

	// includeOthers: sum excluded rows per series into synthetic "Other" rows
	const seriesValues = new Map<unknown, number>();
	const seriesOrder: unknown[] = [];
	for (const i of excludeIndices) {
		const s = seriesCol[i];
		if (!seriesValues.has(s)) seriesOrder.push(s);
		seriesValues.set(s, (seriesValues.get(s) || 0) + (Number(valueCol[i]) || 0));
	}

	const outLen = keepIndices.length + seriesOrder.length;
	const columns: Record<string, Float32Array | unknown[]> = {};

	for (const colName of data.columnNames) {
		const src = data.getColumn(colName);
		if (!src) continue;

		if (src instanceof Float32Array) {
			const dst = new Float32Array(outLen);
			for (let i = 0; i < keepIndices.length; i++) dst[i] = src[keepIndices[i]];
			// "Other" rows: value column gets summed total per series, others get 0
			for (let j = 0; j < seriesOrder.length; j++) {
				dst[keepIndices.length + j] =
					colName === valueField ? seriesValues.get(seriesOrder[j]) || 0 : 0;
			}
			columns[colName] = dst;
		} else {
			const dst: unknown[] = keepIndices.map((i) => src[i]);
			for (let j = 0; j < seriesOrder.length; j++) {
				if (colName === bandField) dst.push('Other');
				else if (src === seriesCol) dst.push(seriesOrder[j]);
				else dst.push(null);
			}
			columns[colName] = dst;
		}
	}

	return new ColumnDataAccessor(columns, outLen);
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
		spec: { transform: 'stackY', ...(options.offset ? { offset: options.offset } : {}) },
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
		spec: { transform: 'stackX', ...(options.offset ? { offset: options.offset } : {}) },
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
		const rawValue = Number(valueCol[i]);
		if (rawValue !== rawValue) {
			// NaN (null in Arrow) — preserve so shaders create gaps
			lo[i] = NaN;
			hi[i] = NaN;
			continue;
		}
		const cumulative = cumulatives.get(group) || 0;
		lo[i] = cumulative;
		hi[i] = cumulative + rawValue;
		cumulatives.set(group, cumulative + rawValue);
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
		spec: { transform: 'normalize' },
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
		spec: { transform: 'dodge', ...(options.bandwidth ? { bandwidth: options.bandwidth } : {}) },
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

// -----------------------------------------------------------------------------
// withImplicitStack — Observable Plot's maybeStackY/maybeStackX pattern
// -----------------------------------------------------------------------------

/**
 * Auto-inject a stack transform when the mark uses shorthand (y/x) without
 * explicit bounds (y1/y2 or x1/x2). Appends stack at end of the transforms
 * array so user transforms like topN run first, then stacking runs on the
 * filtered result.
 *
 * Mirrors Observable Plot's maybeStackY/maybeStackX: marks that specify only
 * `y` (not `y1`/`y2`) get automatic stacking. Specifying explicit bounds
 * opts out.
 */
export function withImplicitStack(
	transforms: Transform[],
	hasExplicitBounds: boolean,
	direction: 'x' | 'y'
): Transform[] {
	if (hasExplicitBounds) return transforms;
	if (transforms.some((t) => t.type === 'stack')) return transforms;
	return [...transforms, direction === 'y' ? stackY() : stackX()];
}

export { TransformCompiler } from './TransformCompiler';
