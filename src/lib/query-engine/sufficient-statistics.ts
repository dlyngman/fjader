/**
 * Sufficient statistics for pre-aggregation data cubes.
 *
 * Pure functions that analyze a mark's selectDef and produce:
 * - cubeCols: columns for the materialized cube (dimensions + partial aggregates)
 * - outputSelect: rewritten expressions that recombine partials at query time
 * - cubeGroupBy: GROUP BY expressions for the cube
 *
 * Unsupported aggregates (DISTINCT, MEDIAN, etc.) cause the entire mark to
 * fall back to base-table queries — no partial preagg.
 */

import {
	collectAggregates,
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
	isColumnRef,
	isAggregateExpression,
	type AggregateNode,
	type ExprNode
} from '@uwdata/mosaic-sql';
import { isWindowExpression } from '$lib/sql/expression-utils';

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
	/** Columns for the cube SELECT (dimensions as-is + partial aggregate cols). */
	cubeCols: Record<string, ExprNode>;
	/** Rewritten expressions for the brush query (recombined partials). */
	outputSelect: Record<string, ExprNode>;
	/** GROUP BY expressions for the cube (dimension columns only, no bin cols). */
	cubeGroupBy: ExprNode[];
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
 */
export function rewriteForPreagg(
	selectDef: Record<string, unknown>
): PreaggAnalysis | null {
	const cubeCols: Record<string, ExprNode> = {};
	const outputSelect: Record<string, ExprNode> = {};
	const cubeGroupBy: ExprNode[] = [];

	let statCounter = 0;

	for (const [channel, expr] of Object.entries(selectDef)) {
		if (expr == null || !isNode(expr)) return null;

		// Window expressions → bail (v1: entire mark falls back)
		if (isWindowExpression(expr)) return null;

		const aggFlag = isAggregateExpression(expr as ExprNode);

		if (aggFlag === 0) {
			// Pure dimension (column ref, CASE expression, etc.)
			cubeCols[channel] = expr as ExprNode;
			outputSelect[channel] = column(channel);
			cubeGroupBy.push(column(channel));
		} else {
			// Contains aggregate(s) — try to decompose
			const aggNodes = collectAggregates(expr as ExprNode);
			if (aggNodes.length === 0) return null; // verbatim aggregate text, can't analyze

			const rewriteMap = new Map<ExprNode, ExprNode>();

			for (const agg of aggNodes) {
				const result = sufficientStats(agg, cubeCols, statCounter);
				if (!result) return null; // unsupported aggregate
				rewriteMap.set(agg, result.outputExpr);
				statCounter = result.nextCounter;
			}

			outputSelect[channel] = rewrite(expr as ExprNode, rewriteMap) as ExprNode;
		}
	}

	return { cubeCols, outputSelect, cubeGroupBy };
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
 * Returns the recombined output expression and adds partial columns to cubeCols.
 * Returns null if the aggregate is not decomposable.
 */
function sufficientStats(
	agg: AggregateNode,
	cubeCols: Record<string, ExprNode>,
	counter: number
): StatResult | null {
	if (agg.isDistinct) return null;

	const name = agg.name.toLowerCase();
	const args = agg.args;

	switch (name) {
		case 'count': {
			const [col, counter1] = addStat(cubeCols, count(...args), agg, counter);
			return {
				outputExpr: coalesce(sum(column(col)), literal(0)) as ExprNode,
				nextCounter: counter1
			};
		}

		case 'sum': {
			const [col, counter1] = addStat(cubeCols, sum(args[0]), agg, counter);
			return {
				outputExpr: sum(column(col)) as ExprNode,
				nextCounter: counter1
			};
		}

		case 'avg': {
			const [sumCol, counter1] = addStat(cubeCols, sum(args[0]), agg, counter);
			const [cntCol, counter2] = addStat(cubeCols, count(args[0]), agg, counter1);
			return {
				outputExpr: div(
					sum(column(sumCol)),
					coalesce(sum(column(cntCol)), literal(1))
				) as ExprNode,
				nextCounter: counter2
			};
		}

		case 'min': {
			const [col, counter1] = addStat(cubeCols, min(args[0]), agg, counter);
			return {
				outputExpr: min(column(col)) as ExprNode,
				nextCounter: counter1
			};
		}

		case 'max': {
			const [col, counter1] = addStat(cubeCols, max(args[0]), agg, counter);
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
 * Add a partial-statistic column to the cube, deduplicating by expression string.
 * Returns [columnName, nextCounter].
 */
function addStat(
	cubeCols: Record<string, ExprNode>,
	expr: ExprNode,
	sourceAgg: AggregateNode,
	counter: number
): [string, number] {
	// Propagate FILTER clause from source aggregate
	const finalExpr = sourceAgg.filter ? (expr as AggregateNode).where(sourceAgg.filter) : expr;
	const key = finalExpr.toString();

	// Check for existing identical partial
	for (const [name, existing] of Object.entries(cubeCols)) {
		if (name.startsWith('__ps') && existing.toString() === key) {
			return [name, counter];
		}
	}

	const colName = `__ps${counter}`;
	cubeCols[colName] = finalExpr as ExprNode;
	return [colName, counter + 1];
}
