/**
 * Sufficient statistics for pre-aggregation tables.
 *
 * Pure functions that analyze a mark's selectDef and produce:
 * - preaggCols: columns for the materialized preagg table (dimensions + partial aggregates)
 * - outputSelect: rewritten expressions that recombine partials at query time
 * - preaggGroupBy: GROUP BY expressions for the preagg table
 *
 * Unsupported aggregates (DISTINCT, MEDIAN, etc.) cause the entire mark to
 * fall back to base-table queries — no partial preagg.
 */

import {
	collectAggregates,
	collectColumns,
	rewrite,
	sum,
	count,
	min,
	max,
	coalesce,
	div,
	column,
	cast,
	literal,
	floor,
	mul,
	sub,
	isNode,
	isAggregateExpression,
	WindowNode,
	type AggregateNode,
	type ExprNode
} from '@uwdata/mosaic-sql';
import { isWindowExpression, isVerbatimWindowExpression } from '$lib/sql/expression-utils';
import { buildOuterWindow } from '$lib/components/marks/lifecycle/query-builder';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrushActivation {
	/** Column expression the brush filters on (may include epoch transform). */
	columnRef: ExprNode;
	/** Scale domain for computing bin width. */
	domain: [number, number];
	/** Chart dimension in pixels for bin resolution. */
	pixelExtent: number;
}

export interface PreaggAnalysis {
	/** Columns for the preagg SELECT (dimensions as-is + partial aggregate cols). */
	preaggCols: Record<string, ExprNode>;
	/** Rewritten expressions for the brush query (recombined partials). */
	outputSelect: Record<string, ExprNode>;
	/** GROUP BY expressions for the preagg table (dimension columns only, no bin cols). */
	preaggGroupBy: ExprNode[];
	/** Channels needing CTE window wrapping. null if no windows. */
	windowChannels: Record<string, WindowNode> | null;
}

export interface BinExprResult {
	expr: ExprNode;
	d0: number;
	scaleFactor: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a mark's selectDef for pre-aggregation compatibility.
 * Returns null if any channel is unsupported (window functions, DISTINCT, etc.).
 *
 * `passthroughChannels` is a channel→field map for channels whose raw config
 * value was a column-name passthrough. When a window expression references
 * one of those source columns, we rewrite the window def to use the channel
 * alias instead — folding away the redundant extra dimension.
 */
export function rewriteForPreagg(
	selectDef: Record<string, unknown>,
	passthroughChannels?: Map<string, string>
): PreaggAnalysis | null {
	const preaggCols: Record<string, ExprNode> = {};
	const outputSelect: Record<string, ExprNode> = {};
	const preaggGroupBy: ExprNode[] = [];
	const windowChannels: Record<string, WindowNode> = {};

	// Inverse map: source field → channel alias. Built from passthroughChannels
	// (which only includes provably 1:1 channel→field mappings). Used to
	// rewrite window def col refs to channel aliases when applicable.
	const fieldToChannel = new Map<string, string>();
	if (passthroughChannels) {
		for (const [ch, field] of passthroughChannels) {
			fieldToChannel.set(field, ch);
		}
	}

	let statCounter = 0;

	for (const [channel, expr] of Object.entries(selectDef)) {
		if (expr == null || !isNode(expr)) return null;

		if (isWindowExpression(expr)) {
			const windowNode = expr as unknown as WindowNode;

			// Only handle windows wrapping decomposable aggregates.
			// WindowFunctionNode (ROW_NUMBER, RANK) has a different shape — bail.
			if (!isAggregateExpression(windowNode.func)) return null;

			const innerFunc = windowNode.func as AggregateNode;
			const result = sufficientStats(innerFunc, preaggCols, statCounter);
			if (!result) return null; // DISTINCT, unsupported aggregate, etc.
			statCounter = result.nextCounter;

			// Store recombined aggregate WITHOUT window wrapping
			outputSelect[channel] = result.outputExpr;

			// Window defs reference raw field names (e.g. PARTITION BY "region",
			// ORDER BY "date"). For each ref, we either:
			//
			//   (a) Rewrite to a channel alias, when another non-window channel
			//       passes through the same source column. The channel's CAST/
			//       EPOCH/CASE wrapping is provably 1:1 with the source value
			//       under DivePlot's automatic transforms — monotonic for ORDER
			//       BY, distinct-preserving for PARTITION BY. This avoids
			//       carrying redundant raw columns through the preagg table.
			//
			//   (b) Add the raw column as an extra preagg dimension. Used for
			//       window-referenced columns that no channel covers, including
			//       any selectDef channel that's already wrapped in an opaque
			//       expression we can't analyze (CASE, FRAGMENT, etc.). Extra
			//       output columns are harmless — marks only read channels they
			//       declared.
			const windowRewriteMap = new Map<ExprNode, ExprNode>();
			for (const col of collectColumns(windowNode.def as unknown as ExprNode)) {
				const fieldName = col.column;
				if (fieldName in preaggCols) continue;

				const channelAlias = fieldToChannel.get(fieldName);
				if (channelAlias) {
					// (a) — rewrite to channel alias
					windowRewriteMap.set(col, column(channelAlias) as ExprNode);
					continue;
				}

				// (b) — add as raw extra dimension
				const colRef = column(fieldName) as ExprNode;
				preaggCols[fieldName] = colRef;
				outputSelect[fieldName] = colRef;
				preaggGroupBy.push(colRef);
			}

			// Outer CTE window: outerAgg(column(channel)) OVER (rewritten def).
			// Shared with the base path so both produce identical numbers.
			const outer = buildOuterWindow(channel, windowNode, windowRewriteMap);
			if (!outer) return null; // no outer counterpart for this aggregate
			windowChannels[channel] = outer;
			continue;
		}

		// A verbatim fragment containing a window never reaches the WINDOW branch
		// above (it is a FRAGMENT, not a WINDOW node) and reads as aggFlag 0 —
		// indistinguishable from a plain column ref — so the pure-dimension
		// branch below would put a window into GROUP BY. Bail, which is what
		// this function's contract promises for unsupported channels.
		if (isVerbatimWindowExpression(expr)) return null;

		const aggFlag = isAggregateExpression(expr as ExprNode);

		if (aggFlag === 0) {
			// Pure dimension (column ref, CASE expression, etc.). Grouped by the
			// expression, not the channel name: GROUP BY "x" binds to a source
			// column named x before the select alias, so a channel named like a
			// column of the table would group by the wrong thing.
			preaggCols[channel] = expr as ExprNode;
			outputSelect[channel] = column(channel);
			preaggGroupBy.push(expr as ExprNode);
		} else {
			// Contains aggregate(s) — try to decompose
			const aggNodes = collectAggregates(expr as ExprNode);
			if (aggNodes.length === 0) return null; // verbatim aggregate text, can't analyze

			const rewriteMap = new Map<ExprNode, ExprNode>();

			for (const agg of aggNodes) {
				const result = sufficientStats(agg, preaggCols, statCounter);
				if (!result) return null; // unsupported aggregate
				rewriteMap.set(agg, result.outputExpr);
				statCounter = result.nextCounter;
			}

			outputSelect[channel] = rewrite(expr as ExprNode, rewriteMap) as ExprNode;
		}
	}

	return {
		preaggCols,
		outputSelect,
		preaggGroupBy,
		windowChannels: Object.keys(windowChannels).length > 0 ? windowChannels : null
	};
}

/**
 * Build a pixel-bin expression for a brush dimension.
 * Produces: CAST(FLOOR((columnRef - d0) * scaleFactor) AS INTEGER)
 */
export function buildBinExpr(
	columnRef: ExprNode,
	domain: [number, number],
	pixelExtent: number
): BinExprResult {
	const d0 = domain[0];
	const scaleFactor = pixelExtent / (domain[1] - domain[0]);

	const expr = cast(
		floor(mul(sub(columnRef, literal(d0)), literal(scaleFactor))),
		'INTEGER'
	) as ExprNode;

	return { expr, d0, scaleFactor };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface StatResult {
	outputExpr: ExprNode;
	nextCounter: number;
}

/**
 * Compute sufficient statistics for a single aggregate node.
 * Returns the recombined output expression and adds partial columns to preaggCols.
 * Returns null if the aggregate is not decomposable.
 */
function sufficientStats(
	agg: AggregateNode,
	preaggCols: Record<string, ExprNode>,
	counter: number
): StatResult | null {
	if (agg.isDistinct) return null;

	const name = agg.name.toLowerCase();
	const args = agg.args;

	switch (name) {
		case 'count': {
			const [col, counter1] = addStat(preaggCols, count(...args), agg, counter);
			return {
				outputExpr: coalesce(sum(column(col)), literal(0)) as ExprNode,
				nextCounter: counter1
			};
		}

		case 'sum': {
			const [col, counter1] = addStat(preaggCols, sum(args[0]), agg, counter);
			return {
				outputExpr: sum(column(col)) as ExprNode,
				nextCounter: counter1
			};
		}

		case 'avg': {
			const [sumCol, counter1] = addStat(preaggCols, sum(args[0]), agg, counter);
			const [cntCol, counter2] = addStat(preaggCols, count(args[0]), agg, counter1);
			return {
				outputExpr: div(sum(column(sumCol)), coalesce(sum(column(cntCol)), literal(1))) as ExprNode,
				nextCounter: counter2
			};
		}

		case 'min': {
			const [col, counter1] = addStat(preaggCols, min(args[0]), agg, counter);
			return {
				outputExpr: min(column(col)) as ExprNode,
				nextCounter: counter1
			};
		}

		case 'max': {
			const [col, counter1] = addStat(preaggCols, max(args[0]), agg, counter);
			return {
				outputExpr: max(column(col)) as ExprNode,
				nextCounter: counter1
			};
		}

		default:
			return null;
	}
}

/**
 * Add a partial-statistic column to the preagg table, deduplicating by expression string.
 * Returns [columnName, nextCounter].
 */
function addStat(
	preaggCols: Record<string, ExprNode>,
	expr: ExprNode,
	sourceAgg: AggregateNode,
	counter: number
): [string, number] {
	// Propagate FILTER clause from source aggregate
	const finalExpr = sourceAgg.filter ? (expr as AggregateNode).where(sourceAgg.filter) : expr;
	const key = finalExpr.toString();

	// Check for existing identical partial
	for (const [name, existing] of Object.entries(preaggCols)) {
		if (name.startsWith('__ps') && existing.toString() === key) {
			return [name, counter];
		}
	}

	const colName = `__ps${counter}`;
	preaggCols[colName] = finalExpr as ExprNode;
	return [colName, counter + 1];
}
