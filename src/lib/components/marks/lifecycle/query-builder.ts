import {
	isNode,
	isAggregateExpression,
	isColumnRef,
	isColumnParam,
	column as sqlColumn,
	cast,
	coalesce,
	sql,
	isNotNull,
	and,
	Query
} from '@uwdata/mosaic-sql';
import type { ExprNode } from '@uwdata/mosaic-sql';
import { isWindowExpression } from '$lib/sql/expression-utils';
import { isBinExpression } from '$lib/sql/bin';
import { isRollingAvgExpression } from '$lib/sql/rolling-avg';
import { isNumericScale } from '$lib/scales/scale-categories';
import type { TransformCompiler } from '$lib/transforms/TransformCompiler';

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
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Classify select expressions and build the SQL alias map + query parts.
 * The selectDef uses channel names as keys (internal convention).
 * The aliasMap records what SQL alias each channel gets:
 *   simple field ref -> field name; expressions -> channel name.
 */
export function buildQueryParts(
	select: Record<string, unknown>,
	orderConfig: OrderConfig | undefined,
	hasSQLTransforms: boolean
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

	// Store channel names for connected mark ordering.
	// sqlColumn() nodes are built at query assembly time using
	// the appropriate alias convention (channel or field-based).
	let orderChannels: string[] | null = null;
	if (orderConfig) {
		const { seriesChannel, dimensionChannel } = orderConfig;
		const chans: string[] = [];

		if (aliasMap.has('__facet')) chans.push('__facet');
		if (seriesChannel && aliasMap.has(seriesChannel)) chans.push(seriesChannel);
		if (dimensionChannel && aliasMap.has(dimensionChannel)) chans.push(dimensionChannel);

		if (chans.length > 0) {
			orderChannels = chans;
		}
	}

	return {
		selectDef,
		nonAggregateGroupBy,
		hasAggregates,
		hasWindowAggregates,
		hasSQLTransforms,
		orderChannels,
		aliasMap
	};
}

/**
 * Assemble a Query from cached query parts + per-call filter.
 * This is the part that runs on every Mosaic re-query (filter changes).
 */
export function assembleQuery(
	sourceTable: string,
	parts: QueryParts,
	filter: unknown[],
	filterNulls: unknown[] | null | undefined,
	transformCompiler: TransformCompiler,
	forMosaic: boolean,
	numericCastChannels?: Set<string>
): Query {
	const {
		selectDef,
		nonAggregateGroupBy,
		hasAggregates,
		hasSQLTransforms,
		orderChannels,
		aliasMap
	} = parts;

	// When forMosaic is true, translate channel-named selectDef to field-based
	// aliases so Mosaic's PreAggregator sees the column names it expects.
	// Internal callers (sidecar, tooltip) pass false to keep channel names.
	let effectiveSelectDef: Record<string, unknown>;
	if (forMosaic) {
		effectiveSelectDef = {};
		for (const [channel, expr] of Object.entries(selectDef)) {
			const alias = aliasMap.get(channel) ?? channel;
			// Wrap numeric-scale channels in COALESCE(CAST(... AS REAL), 'NaN'::REAL)
			// so DuckDB returns Float32Array (zero-copy in DataAccessor).
			// COALESCE converts SQL NULL to the NaN float value, ensuring the Arrow
			// column has nullCount=0 and garbage-free buffers for GPU shaders.
			const finalExpr = numericCastChannels?.has(channel)
				? coalesce(cast(expr, 'REAL'), sql`'NaN'::REAL`)
				: expr;
			effectiveSelectDef[alias] = finalExpr;
		}
	} else {
		effectiveSelectDef = selectDef;
	}

	// Build fresh Query (cheap object construction)
	const q = Query.from(sourceTable).select(effectiveSelectDef as Record<string, ExprNode>);

	if (hasAggregates && nonAggregateGroupBy.length > 0) {
		q.groupby(nonAggregateGroupBy as ExprNode[]);
	}

	let queryWithTransforms = q;
	if (hasSQLTransforms) {
		queryWithTransforms = transformCompiler.applyToQuery(q);
	}

	// Apply filters (the only part that varies per-call)
	const allFilters = [...filter] as ExprNode[];
	if (filterNulls && Array.isArray(filterNulls)) {
		allFilters.push(...filterNulls.map((col) => isNotNull(col as ExprNode)));
	}
	if (allFilters.length > 0) {
		queryWithTransforms = queryWithTransforms.where(and(allFilters));
	}

	// ORDER BY uses the appropriate alias convention
	if (orderChannels) {
		const orderCols = orderChannels.map((ch) => {
			const name = forMosaic ? (aliasMap.get(ch) ?? ch) : ch;
			return sqlColumn(name);
		});
		queryWithTransforms = queryWithTransforms.orderby(...orderCols);
	}

	return queryWithTransforms;
}
