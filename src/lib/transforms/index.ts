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
 * Resolve the value/band aliases for a channel-aware SQL transform from the
 * mark config, validated against the query's own select list. Mirrors the
 * JS path: value axis is y for vertical marks, x for horizontal (barx); the
 * mark lifecycle has already resolved y → y2 etc. for extent-based marks.
 * Shared by topN and normalize — the two transforms that need "which
 * channel is the measure, which is the group" (proposals/review_preagg_v2_phase2.md).
 */
function resolveValueAndBand(
	aliases: string[],
	options: { by?: string },
	config: MarkConfig | undefined,
	transformName: string
): { by: string; band: string } {
	const isHorizontal = config?.markType === 'barx';
	const by = options.by ?? (isHorizontal ? config?.x : config?.y);
	const band = isHorizontal ? config?.y : config?.x;

	if (!by || !aliases.includes(by)) {
		throw new Error(
			`${transformName}: value column "${by ?? '(none)'}" not in query select [${aliases.join(', ')}].` +
				CONSTANT_CHANNEL_HINT
		);
	}
	if (!band || !aliases.includes(band)) {
		throw new Error(
			`${transformName}: band column "${band ?? '(none)'}" not in query select [${aliases.join(', ')}].` +
				CONSTANT_CHANNEL_HINT
		);
	}
	return { by, band };
}

/** A resolved channel missing from the query select is usually a constant
 *  (e.g. x={1}) — constants are injected client-side after the query runs,
 *  so a SQL transform can never see them. Force the JS fallback instead. */
const CONSTANT_CHANNEL_HINT =
	" If this channel is a constant (a plain number prop), pass { engine: 'js' } — SQL transforms run before constants are injected.";

/** topN also needs the series (fill) channel, when present in the select list. */
function resolveTopNColumns(
	aliases: string[],
	options: TopNOptions,
	config: MarkConfig | undefined
): { by: string; band: string; series: string | null } {
	const { by, band } = resolveValueAndBand(aliases, options, config, 'topN');
	const fill = config?.fill;
	const series = typeof fill === 'string' && aliases.includes(fill) ? fill : null;
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
		apply(data: DataAccessor, config: MarkConfig, scales?: ScaleMap) {
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

			// The band channel carries dim ids, so a synthetic "Other" row cannot
			// invent one — the engine reserved it at setup (§16.9). Keyed by data
			// column name, which is what bandField is.
			const otherId = scales?.otherIdsByColumn?.[bandField];

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
					valueField,
					otherId
				);
			}

			// Simple path: no series column, rank individual rows
			if (data.length <= n) return data;
			return topNSimple(data, n, valueCol, bandField, options, otherId);
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
	options: TopNOptions,
	otherId?: number
): DataAccessor {
	const indices = Array.from({ length: data.length }, (_, i) => i);
	indices.sort((a, b) => (Number(valueCol[b]) || 0) - (Number(valueCol[a]) || 0));

	const topIndices = indices.slice(0, n);
	const bandCol = data.getColumn(bandField);
	// A numeric band column holds identity ids; the Other row needs the reserved
	// one. Summing it like any other numeric column — which is what this used to
	// do — produces the sum of the EXCLUDED ids, an arbitrary number that either
	// falls outside the scale's block or lands on a live category (§16.9).
	const bandIsIds = bandCol instanceof Float32Array;

	let includeOthers = !!options.includeOthers;
	if (includeOthers && bandIsIds && otherId == null) {
		console.warn(
			`[topN] includeOthers on "${bandField}" needs a reserved identity id and has none; ` +
				`omitting the Other row rather than fabricating a category.`
		);
		includeOthers = false;
	}

	// A real category may already carry the reserved id — reserveSynthetic reuses
	// it rather than duplicating the value. If that category survived the cut,
	// fold the excluded total into its row instead of appending a second row with
	// the same id, which would draw two bars in one slot.
	const foldIdx =
		includeOthers && bandIsIds ? topIndices.findIndex((i) => bandCol[i] === otherId) : -1;
	const appendOther = includeOthers && foldIdx < 0;

	const outLen = appendOther ? n + 1 : n;
	const columns: Record<string, Float32Array | unknown[]> = {};

	for (const colName of data.columnNames) {
		const src = data.getColumn(colName);
		if (!src) continue;

		if (src instanceof Float32Array) {
			const dst = new Float32Array(outLen);
			for (let i = 0; i < n; i++) dst[i] = src[topIndices[i]];
			if (includeOthers) {
				if (colName === bandField) {
					// Identity, not an aggregate. Already correct when folding.
					if (appendOther) dst[n] = otherId!;
				} else {
					let sum = 0;
					for (let i = n; i < indices.length; i++) sum += src[indices[i]];
					if (appendOther) dst[n] = sum;
					else dst[foldIdx] += sum;
				}
			}
			columns[colName] = dst;
		} else {
			const dst: unknown[] = topIndices.map((i) => src[i]);
			if (appendOther) {
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
	valueField: string,
	otherId?: number
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

	// A numeric band column holds identity ids, so the Other rows need the
	// reserved one. They used to get 0 — a real category id — which drew the
	// Other bar on top of whichever category owned it (§16.9).
	const bandIsIds = bandColData instanceof Float32Array;
	if (bandIsIds && otherId == null) {
		console.warn(
			`[topN] includeOthers on "${bandField}" needs a reserved identity id and has none; ` +
				`omitting the Other rows rather than fabricating a category.`
		);
		return gatherRows(data, keepIndices);
	}

	// includeOthers: sum excluded rows per series into synthetic "Other" rows
	const seriesValues = new Map<unknown, number>();
	const seriesOrder: unknown[] = [];
	for (const i of excludeIndices) {
		const s = seriesCol[i];
		if (!seriesValues.has(s)) seriesOrder.push(s);
		seriesValues.set(s, (seriesValues.get(s) || 0) + (Number(valueCol[i]) || 0));
	}

	// A real category may already carry the reserved id (reserveSynthetic reuses
	// rather than duplicating). Where such a row survived the cut for a given
	// series, fold that series' total into it instead of appending a duplicate
	// (category, series) row.
	const foldFor = new Map<unknown, number>();
	if (bandIsIds) {
		for (let k = 0; k < keepIndices.length; k++) {
			const i = keepIndices[k];
			if (bandColData[i] === otherId && seriesValues.has(seriesCol[i])) {
				foldFor.set(seriesCol[i], k);
			}
		}
	}
	const appended = seriesOrder.filter((sv) => !foldFor.has(sv));

	const outLen = keepIndices.length + appended.length;
	const columns: Record<string, Float32Array | unknown[]> = {};

	for (const colName of data.columnNames) {
		const src = data.getColumn(colName);
		if (!src) continue;

		if (src instanceof Float32Array) {
			const dst = new Float32Array(outLen);
			for (let i = 0; i < keepIndices.length; i++) dst[i] = src[keepIndices[i]];
			// Folded series: add the excluded total into the surviving row.
			if (colName === valueField) {
				for (const [sv, k] of foldFor) dst[k] += seriesValues.get(sv) || 0;
			}
			// Appended "Other" rows: the value column gets the per-series total,
			// the band column the reserved id, everything else 0.
			for (let j = 0; j < appended.length; j++) {
				dst[keepIndices.length + j] =
					colName === valueField
						? seriesValues.get(appended[j]) || 0
						: colName === bandField
							? otherId!
							: 0;
			}
			columns[colName] = dst;
		} else {
			const dst: unknown[] = keepIndices.map((i) => src[i]);
			for (let j = 0; j < appended.length; j++) {
				if (colName === bandField) dst.push('Other');
				else if (src === seriesCol) dst.push(appended[j]);
				else dst.push(null);
			}
			columns[colName] = dst;
		}
	}

	return new ColumnDataAccessor(columns, outLen);
}

/** Gather the given row indices from every column, preserving typed arrays. */
function gatherRows(data: DataAccessor, indices: number[]): DataAccessor {
	const columns: Record<string, Float32Array | unknown[]> = {};
	for (const colName of data.columnNames) {
		const src = data.getColumn(colName);
		if (!src) continue;
		if (src instanceof Float32Array) {
			const dst = new Float32Array(indices.length);
			for (let i = 0; i < indices.length; i++) dst[i] = src[indices[i]];
			columns[colName] = dst;
		} else {
			columns[colName] = indices.map((i) => src[i]);
		}
	}
	return new ColumnDataAccessor(columns, indices.length);
}

// -----------------------------------------------------------------------------
// stackY / stackX — cumulative offset stacking
//
// SQL path (default): cumulative window SUM, PARTITION BY band (plus `__facet`
// when the mark is faceted — a cell is its own stack) ORDER BY the
// series channel. The series channel is whatever's already in the select — for
// an ordinal color scale on fill, that is the dim's identity id (step 3b;
// before `58b0023` it was a CASE-inlined domain-ordered index).
//
// Ordering by it still reproduces the legend's stacking order, but it is worth
// knowing WHY, because nothing here enforces it. Two independent orderings
// happen to agree:
//
//   the dim    ROW_NUMBER() OVER (ORDER BY value)     -> ids
//   the scale  SELECT DISTINCT color ORDER BY color   -> legend order
//
// Both alphabetical, so id order IS legend order. There is no colour `domain`
// prop today (MarkColor builds the scale with type/scheme/constant/exponent
// only), so a non-alphabetical legend order is unreachable.
//
// Two things would break it, and neither would fail loudly — the chart would
// stack in a different order than it lists:
//
//   - A second table appending to the dim. It is append-only, so that table's
//     new categories get ids after every existing one rather than interleaved,
//     and a stacked mark on it orders by insertion epoch.
//   - Adding an explicit colour domain. That is the feature that turns this
//     from a coincidence into a bug.
//
// Both are pinned in categorical-identity.integration.test.ts, including the
// divergence, so a change to either side fails a test rather than a chart.
//
// Deliberately NOT fixed with a rank expression in the ORDER BY: that would put
// display order back into the query text, so a legend reorder would rewrite the
// SQL and invalidate preagg cubes — the exact coupling the identity work
// removed, reintroduced for a case that does not currently exist.
//
// The legacy JS path below never looks at fill at all and instead relies on row
// encounter order (the query's plain ORDER BY on the raw fill value).
// NaN in the value column must not poison the running total for later rows
// in the partition (matches the JS path's documented gap semantics) — done
// with a FILTER clause excluding NaN rows from the SUM, and a CASE forcing
// NaN back onto the row whose own value is NaN.
// JS path (engine: 'js'): unchanged typed-array implementation, fallback.
// -----------------------------------------------------------------------------

type StackOffset = null | 'expand' | 'center';

interface StackYOptions {
	offset?: StackOffset;
	/** Force JS execution path. Default: SQL. */
	engine?: 'sql' | 'js';
}

interface StackXOptions {
	offset?: StackOffset;
	/** Force JS execution path. Default: SQL. */
	engine?: 'sql' | 'js';
}

export function stackY(options: StackYOptions & { engine: 'js' }): JsTransform;
export function stackY(options?: StackYOptions): SqlTransform;
export function stackY(options: StackYOptions = {}): SqlTransform | JsTransform {
	if (options.engine === 'js') return stackYJS(options);
	return stackSQL('y', options);
}

export function stackX(options: StackXOptions & { engine: 'js' }): JsTransform;
export function stackX(options?: StackXOptions): SqlTransform;
export function stackX(options: StackXOptions = {}): SqlTransform | JsTransform {
	if (options.engine === 'js') return stackXJS(options);
	return stackSQL('x', options);
}

/** Resolve band (group) / value column aliases for a stack direction, validated against the select list. */
function resolveStackColumns(
	aliases: string[],
	config: MarkConfig | undefined,
	direction: 'y' | 'x'
): { band: string; value: string; series: string | null } {
	const bandAxis = direction === 'y' ? 'x' : 'y';
	const band = config?.[bandAxis] as string | undefined;
	const value = config?.[direction] as string | undefined;

	if (!band || !aliases.includes(band)) {
		throw new Error(
			`stack${direction === 'y' ? 'Y' : 'X'}: band column "${band ?? '(none)'}" not in query select [${aliases.join(', ')}].` +
				CONSTANT_CHANNEL_HINT
		);
	}
	if (!value || !aliases.includes(value)) {
		throw new Error(
			`stack${direction === 'y' ? 'Y' : 'X'}: value column "${value ?? '(none)'}" not in query select [${aliases.join(', ')}].` +
				CONSTANT_CHANNEL_HINT
		);
	}
	const fill = config?.fill;
	const series = typeof fill === 'string' && aliases.includes(fill) ? fill : null;

	// With no series column there is one row per band, so the cumulative sum equals
	// that row's own value and the stack is arithmetically a no-op — the output is
	// identical to an unstacked mark. That is the correct result, but it is
	// indistinguishable from a broken stack to anyone looking at the chart, so say
	// what is missing rather than silently drawing an ordinary bar.
	if (!series) {
		console.warn(
			`stack${direction === 'y' ? 'Y' : 'X'}: no series column, so stacking has no effect ` +
				`(one row per band). Stacking groups rows within a band by the ordinal ` +
				`fill channel — add fill="<field>" to the mark. Select list: [${aliases.join(', ')}].`
		);
	}

	return { band, value, series };
}

function stackSQL(direction: 'y' | 'x', options: StackYOptions | StackXOptions): SqlTransform {
	const [loName, hiName] = direction === 'y' ? ['y0', 'y1'] : ['x0', 'x1'];

	return {
		stage: 'sql',
		type: 'stack',
		spec: {
			transform: direction === 'y' ? 'stackY' : 'stackX',
			...(options.offset ? { offset: options.offset } : {})
		},
		channels: [loName, hiName],
		apply(query: SelectQuery, config?: MarkConfig) {
			const aliases = getSelectAliases(query);
			const { band, value, series } = resolveStackColumns(aliases, config, direction);

			const valueCol = column(value);
			const bandCol = column(band);
			const notNaN = sqlTag`NOT isnan(${valueCol})`;

			// A facet cell is its own stack. `__facet` joins the partition key
			// whenever the mark is faceted, because a band value repeats across
			// cells — "Adelie" in every one — and partitioning on the band alone
			// pools them into a single running total. The bars in the second cell
			// then start where the first cell's ended, which reads as a stack that
			// does not touch the axis rather than as a wrong number.
			//
			// It is worse than an offset, because ORDER BY over tied series values
			// gives every peer the whole partition's sum: with one series per cell
			// EVERY bar gets the grand total and none of them is right. Verified
			// against DuckDB, not reasoned about.
			//
			// Invisible until now because every faceted bar chart in the repo sets
			// x and fx to the same field, which makes each partition a single row
			// and the pooling a no-op.
			const partition = aliases.includes('__facet')
				? sqlTag`${bandCol}, ${column('__facet')}`
				: bandCol;

			// Cumulative sum through the current row, excluding NaN rows from the
			// running total (they don't poison later segments). Without a series
			// column there's one row per band, so the "cumulative" total already
			// equals that row's own value — correct degenerate case.
			const cumulative = series
				? sqlTag`SUM(${valueCol}) FILTER (WHERE ${notNaN}) OVER (PARTITION BY ${partition} ORDER BY ${column(series)})`
				: sqlTag`SUM(${valueCol}) FILTER (WHERE ${notNaN}) OVER (PARTITION BY ${partition})`;

			// Force this row's own boundaries to NaN when its value is NaN,
			// instead of silently dropping it from the running total.
			let hi: ExprNode = sqlTag`CASE WHEN ${notNaN} THEN ${cumulative} ELSE 'NaN'::REAL END`;
			let lo: ExprNode = sqlTag`${hi} - ${valueCol}`;

			if (options.offset === 'expand' || options.offset === 'center') {
				// Same partition as the cumulative sum above: an `expand` that
				// normalised by a total pooled across cells would not reach 1.
				const total = sqlTag`SUM(${valueCol}) FILTER (WHERE ${notNaN}) OVER (PARTITION BY ${partition})`;
				if (options.offset === 'expand') {
					lo = sqlTag`(${lo}) / NULLIF(${total}, 0)`;
					hi = sqlTag`(${hi}) / NULLIF(${total}, 0)`;
				} else {
					lo = sqlTag`(${lo}) - (${total}) / 2`;
					hi = sqlTag`(${hi}) - (${total}) / 2`;
				}
			}

			const outSelect = passthroughSelect(aliases);
			outSelect[loName] = lo;
			outSelect[hiName] = hi;

			return Query.from({ __stack_base: query }).select(outSelect);
		},
		describe() {
			const parts = [direction === 'y' ? 'Stack Y (SQL)' : 'Stack X (SQL)'];
			if (options.offset) parts.push(`(${options.offset})`);
			return parts.join(' ');
		}
	};
}

/**
 * Stack vertically: groups on x, accumulates y values into y0/y1.
 * Follows Observable Plot's stackY convention.
 * Data must be sorted by (groupField, series) for correct results.
 */
function stackYJS(options: StackYOptions): JsTransform {
	return {
		stage: 'js',
		type: 'stack',
		spec: {
			transform: 'stackY',
			engine: 'js',
			...(options.offset ? { offset: options.offset } : {})
		},
		channels: ['y0', 'y1'],
		apply(data: DataAccessor, config: MarkConfig) {
			return computeStack(data, config.x!, config.y!, 'y0', 'y1', options.offset ?? null);
		},
		describe() {
			const parts = ['Stack Y (JS)'];
			if (options.offset) parts.push(`(${options.offset})`);
			return parts.join(' ');
		}
	};
}

/**
 * Stack horizontally: groups on y, accumulates x values into x0/x1.
 * Follows Observable Plot's stackX convention.
 */
function stackXJS(options: StackXOptions): JsTransform {
	return {
		stage: 'js',
		type: 'stack',
		spec: {
			transform: 'stackX',
			engine: 'js',
			...(options.offset ? { offset: options.offset } : {})
		},
		channels: ['x0', 'x1'],
		apply(data: DataAccessor, config: MarkConfig) {
			return computeStack(data, config.y!, config.x!, 'x0', 'x1', options.offset ?? null);
		},
		describe() {
			const parts = ['Stack X (JS)'];
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
	/** Force JS execution path. Default: SQL. Required when the stacked
	 *  value/band channel is a constant (e.g. x={1}) — constants are
	 *  injected client-side after the query runs, so they don't exist yet
	 *  when a SQL transform assembles the query. */
	engine?: 'sql' | 'js';
}

export function stack(options: LegacyStackOptions & { engine: 'js' }): JsTransform;
export function stack(options?: LegacyStackOptions): SqlTransform;
export function stack(options: LegacyStackOptions = {}): SqlTransform | JsTransform {
	const { direction = 'vertical', ...rest } = options;
	if (direction === 'horizontal') {
		return rest.engine === 'js' ? stackXJS(rest) : stackSQL('x', rest);
	}
	return rest.engine === 'js' ? stackYJS(rest) : stackSQL('y', rest);
}

// -----------------------------------------------------------------------------
// normalize — rescale values to percentages within each group
//
// SQL path (default): window aggregate, value * 100 / SUM(value) OVER (band).
// Operates on the raw (pre-stack) value column, so it must precede stackY/
// stackX in the transforms array — normalize-then-stack commutes with
// stack-then-normalize (scaling by a constant commutes with cumulative sum),
// so this produces identical y0/y1 to the old stack-then-normalize order.
// JS path (engine: 'js'): legacy post-query behavior, including the
// stacked-data (y0/y1) special case, kept for callers that still order
// [stack(), normalize()].
// -----------------------------------------------------------------------------

interface NormalizeOptions {
	/** Value channel to normalize. Default: the mark's value axis (y, or x for barx). */
	by?: string;
	/** Force JS execution path. Default: SQL. */
	engine?: 'sql' | 'js';
}

export function normalize(options: NormalizeOptions & { engine: 'js' }): JsTransform;
export function normalize(options?: NormalizeOptions): SqlTransform;
export function normalize(options: NormalizeOptions = {}): SqlTransform | JsTransform {
	if (options.engine === 'js') return normalizeJS(options);
	return normalizeSQL(options);
}

function normalizeSQL(options: NormalizeOptions): SqlTransform {
	return {
		stage: 'sql',
		type: 'normalize',
		spec: { transform: 'normalize', ...(options.by ? { by: options.by } : {}) },
		apply(query: SelectQuery, config?: MarkConfig) {
			const aliases = getSelectAliases(query);
			const { by, band } = resolveValueAndBand(aliases, options, config, 'normalize');

			// `__facet` joins the partition for the same reason it does in
			// stackSQL: a band value repeats across cells, and a percentage
			// normalised over the pooled total does not reach 100 within any one
			// of them.
			const partition = aliases.includes('__facet')
				? sqlTag`${column(band)}, ${column('__facet')}`
				: column(band);

			const outSelect = passthroughSelect(aliases);
			outSelect[by] =
				sqlTag`${column(by)} * 100 / NULLIF(SUM(${column(by)}) OVER (PARTITION BY ${partition}), 0)`;

			return Query.from({ __normalize_base: query }).select(outSelect);
		},
		describe() {
			return 'Normalize to percentages (SQL)';
		}
	};
}

function normalizeJS(_options: NormalizeOptions): JsTransform {
	return {
		stage: 'js',
		type: 'normalize',
		spec: { transform: 'normalize', engine: 'js' },
		apply(data: DataAccessor, config: MarkConfig) {
			if (data.length === 0) return data;

			const n = data.length;
			// barx swaps value/band axes, same convention as topNJS.
			const isHorizontal = config.markType === 'barx';
			const groupField = (isHorizontal ? config.y : config.x)!;
			const valueField = (isHorizontal ? config.x : config.y)!;

			const groupCol = data.getColumn(groupField);
			const valueCol = data.getColumn(valueField);
			if (!groupCol || !valueCol) return data;

			// Check if stacked (y0/y1 overlays exist; x0/x1 for barx not handled here — SQL path is default)
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
			return 'Normalize to percentages (JS)';
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
 *
 * Stack defaults to SQL, but appending it after a JS-stage transform (e.g.
 * topN with includeOthers) would violate "SQL must precede JS" — and
 * correctly so: stacking has to run on the JS-transformed result in that
 * case, which only JS can do. Force the JS engine when a JS transform
 * already precedes it; otherwise take the SQL default.
 */
export function withImplicitStack(
	transforms: Transform[],
	hasExplicitBounds: boolean,
	direction: 'x' | 'y'
): Transform[] {
	if (hasExplicitBounds) return transforms;
	if (transforms.some((t) => t.type === 'stack')) return transforms;
	const needsJS = transforms.some((t) => t.stage === 'js');
	const implicitStack = needsJS
		? direction === 'y'
			? stackY({ engine: 'js' })
			: stackX({ engine: 'js' })
		: direction === 'y'
			? stackY()
			: stackX();
	return [...transforms, implicitStack];
}

export { TransformCompiler } from './TransformCompiler';
