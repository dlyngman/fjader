import {
	isNode,
	isAggregateExpression,
	isColumnRef,
	isColumnParam,
	column as sqlColumn,
	cast,
	coalesce,
	collectColumns,
	rewrite,
	sql,
	isNotNull,
	and,
	sum,
	avg,
	min,
	max,
	Query,
	WindowNode,
	type AggregateNode,
	type ExprNode
} from '@uwdata/mosaic-sql';
import { isWindowExpression, isVerbatimWindowExpression } from '$lib/sql/expression-utils';
import type { TransformCompiler } from '$lib/transforms/TransformCompiler';
import type { ColumnSchema } from '$lib/query-engine/QueryEngine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrderConfig {
	seriesChannel: string | null;
	dimensionChannel: string;
}

export interface QueryParts {
	selectDef: Record<string, unknown>;
	nonAggregateGroupBy: unknown[];
	hasAggregates: boolean;
	hasWindowAggregates: boolean;
	hasSQLTransforms: boolean;
	orderChannels: string[] | null;
	aliasMap: Map<string, string>;
	/** Channels whose raw config value was a column-name passthrough (string
	 *  or plain ColumnRefNode). For these, the channel alias is provably 1:1
	 *  with the source column under DivePlot's automatic wrappings (epoch /
	 *  CAST for ORDER BY, ordinal CASE for PARTITION BY). Used by preagg to
	 *  fold redundant window col refs into channel aliases. */
	passthroughChannels: Map<string, string>;
}

/** Window functions to apply in an outer CTE over the assembled inner query. */
export interface WindowWrap {
	/** channel → outer WindowNode (already rewritten to reference channel aliases). */
	channels: Record<string, WindowNode>;
	cteName: string;
}

export interface AssembleOptions {
	table: string;
	parts: QueryParts;
	/** Per-call filter predicates (crossfilter, bin filters). */
	filter?: unknown[];
	/** Columns to add IS NOT NULL predicates for. */
	filterNulls?: unknown[] | null;
	transformCompiler: TransformCompiler;
	limit?: number | null;
	/** When set, the inner query is wrapped in a CTE and these window
	 *  functions are applied in the outer SELECT. ORDER BY / LIMIT move to
	 *  the outer query. */
	window?: WindowWrap | null;
}

// ---------------------------------------------------------------------------
// Numeric CAST policy (single rule for every assembly path)
// ---------------------------------------------------------------------------

/**
 * Wrap an expression so DuckDB returns a Float32-compatible REAL with NULLs
 * mapped to NaN: COALESCE(CAST(expr AS REAL), 'NaN'::REAL). Arrow columns then
 * have nullCount=0 and clean buffers for zero-copy GPU upload; shaders detect
 * NaN and discard.
 */
export function castReal(expr: unknown): ExprNode {
	return coalesce(cast(expr as ExprNode, 'REAL'), sql`'NaN'::REAL`) as ExprNode;
}

/**
 * The one rule for which select expressions get CAST-wrapped:
 * - aggregates and window functions: always numeric
 * - non-column SQL nodes (CASE from scale inlining, bin expressions): numeric
 * - column references: only when the schema says the column is numeric
 * - anything else (string columns, params): passthrough
 *
 * Every assembly path (flat, window CTE, preagg cube, preagg query) uses
 * this so the GPU sees one consistent column shape.
 */
export function castNumeric(expr: unknown, schema: Map<string, ColumnSchema> | null): unknown {
	if (expr == null) return expr;
	if (isAggregateExpression(expr as ExprNode) || isWindowExpression(expr)) {
		return castReal(expr);
	}
	if (isNode(expr) && !isColumnRef(expr)) {
		return castReal(expr);
	}
	if (isColumnRef(expr)) {
		const jsType = schema?.get(expr.column)?.jsType;
		if (jsType === 'number') return castReal(expr);
	}
	return expr;
}

// ---------------------------------------------------------------------------
// Window splitting (shared by the base path and the preagg analysis)
// ---------------------------------------------------------------------------

/**
 * Outer-CTE aggregate for each inner aggregate. AVG maps to AVG-of-per-group-
 * means, NOT a pooled mean: for a rolling-average overlay the user expects
 * the smoothed line to track the rendered per-group means, weighting every
 * group equally regardless of row count. COUNT maps to SUM (sum of per-group
 * counts, not count of CTE rows). Both the base path and the preagg path use
 * this mapping so they produce identical results — guarded by
 * window-correctness.integration.test.ts.
 */
export const outerAggBuilders: Record<string, typeof sum> = { count: sum, sum, avg, min, max };

/**
 * Build the outer window node for a channel: outerAgg(column(channel)) OVER
 * (def), with column refs inside the window def rewritten via `rewriteMap`
 * (source field → channel alias) so they resolve against the inner CTE.
 * Returns null when the inner aggregate has no outer counterpart.
 */
export function buildOuterWindow(
	channel: string,
	windowNode: WindowNode,
	rewriteMap: Map<ExprNode, ExprNode>
): WindowNode | null {
	const innerFunc = windowNode.func as AggregateNode;
	const builder = outerAggBuilders[innerFunc.name.toLowerCase()];
	if (!builder) return null;
	const outerFunc = builder(sqlColumn(channel)) as AggregateNode;
	const rewrittenDef =
		rewriteMap.size > 0
			? (rewrite(
					windowNode.def as unknown as ExprNode,
					rewriteMap
				) as unknown as typeof windowNode.def)
			: windowNode.def;
	return new WindowNode(outerFunc, rewrittenDef);
}

export interface WindowSplit {
	/** Inner CTE select: dims (CAST if numeric) + raw aggregates (CAST). */
	innerSelect: Record<string, unknown>;
	/** Inner GROUP BY: one column ref per dimension channel. */
	innerGroupBy: ExprNode[];
	/** Outer window functions keyed by channel. */
	windowChannels: Record<string, WindowNode>;
}

/**
 * Split a selectDef containing window aggregates (e.g. a smooth overlay)
 * into an inner GROUP BY query and outer window functions. DuckDB requires
 * the inner aggregate's columns to be in GROUP BY or inside an aggregate,
 * so the window cannot sit directly on the grouped query.
 *
 * Window defs reference raw source columns (PARTITION BY "region"); they are
 * rewritten to channel aliases when a passthrough channel covers the column.
 * Throws when a window's inner aggregate has no outer counterpart, since
 * that would silently produce wrong numbers.
 */
export function splitWindowSelect(
	selectDef: Record<string, unknown>,
	passthroughChannels: Map<string, string>,
	schema: Map<string, ColumnSchema> | null
): WindowSplit {
	const innerSelect: Record<string, unknown> = {};
	const innerGroupBy: ExprNode[] = [];
	const windowChannels: Record<string, WindowNode> = {};

	const fieldToChannel = new Map<string, string>();
	for (const [ch, field] of passthroughChannels) fieldToChannel.set(field, ch);

	for (const [ch, expr] of Object.entries(selectDef)) {
		if (expr == null) continue;

		if (isWindowExpression(expr)) {
			const windowNode = expr as unknown as WindowNode;
			innerSelect[ch] = castReal(windowNode.func);

			const rewriteMap = new Map<ExprNode, ExprNode>();
			for (const col of collectColumns(windowNode.def as unknown as ExprNode)) {
				const alias = fieldToChannel.get(col.column);
				if (alias) rewriteMap.set(col, sqlColumn(alias) as ExprNode);
			}
			const outer = buildOuterWindow(ch, windowNode, rewriteMap);
			if (!outer) {
				throw new Error(
					`splitWindowSelect: no outer aggregate for window on channel "${ch}" ` +
						`(inner ${(windowNode.func as AggregateNode).name})`
				);
			}
			windowChannels[ch] = outer;
		} else if (isAggregateExpression(expr as ExprNode)) {
			innerSelect[ch] = castReal(expr);
		} else {
			innerSelect[ch] = castNumeric(expr, schema);
			innerGroupBy.push(sqlColumn(ch));
		}
	}

	return { innerSelect, innerGroupBy, windowChannels };
}

// ---------------------------------------------------------------------------
// Query parts
// ---------------------------------------------------------------------------

/**
 * Classify select expressions and build the SQL alias map + query parts.
 * The selectDef uses channel names as keys (internal convention).
 * The aliasMap records what SQL alias each channel gets:
 *   simple field ref -> field name; expressions -> channel name.
 */
export function buildQueryParts(
	select: Record<string, unknown>,
	orderConfig: OrderConfig | undefined | null,
	hasSQLTransforms: boolean,
	passthroughChannels: Map<string, string> = new Map(),
	alignChannels: string[] = []
): QueryParts {
	const selectDef: Record<string, unknown> = {};
	const nonAggregateGroupBy: unknown[] = [];
	const groupByKeys = new Set<string>();
	let hasAggregates = false;
	let hasWindowAggregates = false;
	const aliasMap = new Map<string, string>();

	for (const channel in select) {
		const expr = select[channel];
		if (expr == null) continue;

		const exprNode = isNode(expr) ? expr : sqlColumn(String(expr));

		// SQL alias: field name for simple column refs, channel name
		// for expressions. Matches Mosaic's PreAggregator expectations.
		const sqlAlias = isColumnRef(exprNode) && !isColumnParam(exprNode) ? exprNode.column : channel;

		aliasMap.set(channel, sqlAlias);
		selectDef[channel] = exprNode;

		// A verbatim fragment containing a window reads as aggFlag 0 — the same
		// value a plain column ref gives — so it would fall into the GROUP BY
		// branch below and produce invalid SQL. It cannot be routed to the
		// window path either: splitWindowSelect only destructures real WINDOW
		// nodes and would group by it one layer down. Refuse it here, where the
		// mistake is made, rather than surfacing as a confusing database error.
		if (isVerbatimWindowExpression(exprNode)) {
			throw new Error(
				`buildQueryParts: channel "${channel}" is a verbatim SQL fragment containing a ` +
					`window function, which the query engine cannot analyze. Build it as a ` +
					`structured window node, or move it into a transform's apply() where it ` +
					`wraps the query instead of becoming a channel.`
			);
		}

		if (isAggregateExpression(exprNode)) {
			hasAggregates = true;
		} else if (!isWindowExpression(exprNode)) {
			// Dedup: multiple channels may reference the same column
			if (!groupByKeys.has(sqlAlias)) {
				groupByKeys.add(sqlAlias);
				nonAggregateGroupBy.push(exprNode);
			}
		} else {
			// Window expressions: skip GROUP BY but flag for preagg routing
			hasWindowAggregates = true;
		}
	}

	// Channels to order the outermost query by, leading term first.
	const chans: string[] = [];
	if (aliasMap.has('__facet')) chans.push('__facet');

	// ALIGNMENT FIRST, ahead of any preference about row order.
	//
	// These channels are a correctness requirement: a mark handing its rows to
	// the GPU as an array indexed by category needs row `i` to be the same
	// category on every update, and only the leading ORDER BY term decides that.
	// Everything after it is a tiebreaker.
	//
	// An earlier version appended them LAST, reasoning that a connected mark's
	// ordering should win where the two disagree and that for these marks they
	// could not disagree. Both halves were wrong. A bar mark with a series
	// channel emits ORDER BY fill, y — so rows came back grouped by colour, not
	// by category — and because densify fills an absent category's `fill` with a
	// sentinel, the permutation changed with whichever categories the filter had
	// emptied. The
	// result was bars interpolating toward other categories' values, sometimes.
	//
	// A preference that silently corrupts values is not a preference worth
	// keeping. The tiebreakers still apply, so series segments stay contiguous
	// WITHIN a category, which is what stacking actually needs.
	//
	// And it has to be applied HERE, on the outermost query, not by whichever
	// transform produced the rows. A bar mark stacks by default, so the query is
	// wrapped, and a subquery's ORDER BY does not constrain the outer one — worse,
	// the wrapper is a window PARTITIONed by the same column, so the optimiser
	// re-partitions and the surviving order is the window operator's. An inner
	// ORDER BY looks correct, verifies correct against the database in isolation,
	// and is discarded one level up.
	for (const ch of alignChannels) {
		if (aliasMap.has(ch) && !chans.includes(ch)) chans.push(ch);
	}

	if (orderConfig) {
		const { seriesChannel, dimensionChannel } = orderConfig;
		if (seriesChannel && aliasMap.has(seriesChannel) && !chans.includes(seriesChannel)) {
			chans.push(seriesChannel);
		}
		if (dimensionChannel && aliasMap.has(dimensionChannel) && !chans.includes(dimensionChannel)) {
			chans.push(dimensionChannel);
		}
	}

	const orderChannels = chans.length > 0 ? chans : null;

	return {
		selectDef,
		nonAggregateGroupBy,
		hasAggregates,
		hasWindowAggregates,
		hasSQLTransforms,
		orderChannels,
		aliasMap,
		passthroughChannels
	};
}

// ---------------------------------------------------------------------------
// Assembly — the one sequence every query path follows
// ---------------------------------------------------------------------------

/**
 * Assemble a Query from cached parts + per-call filter.
 *
 * Order is fixed and shared by the flat, window-CTE, and preagg paths:
 *
 *   SELECT parts.selectDef FROM table [GROUP BY dims]
 *   WHERE filter AND nulls          — on the base scan, so transform CTEs
 *                                     (topN ranking etc.) see filtered rows
 *   → SQL transforms (CTE wrapping)
 *   → [window CTE: outer SELECT applies window fns over the inner result]
 *   → ORDER BY orderChannels        — on the outermost query
 *   → LIMIT
 *
 * Callers decide what is CAST-wrapped by preparing parts.selectDef with
 * castNumeric(); assembly never inspects expression types.
 */
/** Output aliases a query exposes to whatever wraps it. */
function selectAliases(query: Query): string[] {
	const sel = (query as unknown as { _select?: { alias?: string }[] })._select;
	if (!Array.isArray(sel)) return [];
	return sel.map((s) => s.alias).filter((a): a is string => !!a);
}

export function assembleQuery(opts: AssembleOptions): Query {
	const { table, parts, filter = [], filterNulls, transformCompiler, limit, window } = opts;
	const { selectDef, nonAggregateGroupBy, hasAggregates, hasSQLTransforms, orderChannels } = parts;

	const q = Query.from(table).select(selectDef as Record<string, ExprNode>);

	if (hasAggregates && nonAggregateGroupBy.length > 0) {
		q.groupby(nonAggregateGroupBy as ExprNode[]);
	}

	const allFilters = [...filter] as ExprNode[];
	if (filterNulls && Array.isArray(filterNulls)) {
		allFilters.push(...filterNulls.map((col) => isNotNull(col as ExprNode)));
	}
	if (allFilters.length > 0) {
		q.where(and(allFilters));
	}

	let result: Query = q;
	if (hasSQLTransforms) {
		result = transformCompiler.applyToQuery(q);
	}

	if (window) {
		const outerSelect: Record<string, unknown> = {};
		// Project what the CTE ACTUALLY exposes, not only what selectDef declared.
		// A SQL transform can add columns — stack's y0/y1, topN's rank — and
		// rebuilding the projection from selectDef alone silently drops them, so a
		// transform's output would survive every other assembly path and vanish in
		// this one. Purely additive: every selectDef key is still projected
		// exactly as before, including the window channels, which are computed
		// out here and so are not aliases of the inner query.
		const exposed = new Set(Object.keys(selectDef));
		if (hasSQLTransforms) {
			for (const alias of selectAliases(result)) exposed.add(alias);
		}
		for (const ch of exposed) {
			// A declared-but-null channel stays dropped; a transform-added one has
			// no selectDef entry at all and must not be caught by the same test.
			if (ch in selectDef && selectDef[ch] == null) continue;
			outerSelect[ch] = ch in window.channels ? castReal(window.channels[ch]) : sqlColumn(ch);
		}
		result = Query.from(window.cteName)
			.select(outerSelect as Record<string, ExprNode>)
			.with({ [window.cteName]: result });
	}

	if (orderChannels) {
		result = result.orderby(...orderChannels.map((ch) => sqlColumn(ch)));
	}
	if (limit) {
		result = result.limit(limit);
	}

	return result;
}
