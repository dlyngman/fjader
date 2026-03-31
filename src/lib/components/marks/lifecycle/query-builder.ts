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
import type { FieldInfoRequest } from '@uwdata/mosaic-core';
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
	hasSQLTransforms: boolean;
	orderChannels: string[] | null;
	aliasMap: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Build field info requests for Mosaic fieldInfo queries.
 * Determines which fields need min/max stats for domain computation.
 */
export function buildFieldInfoRequests(
	select: Record<string, unknown>,
	table: string,
	actualXScaleType: string,
	actualYScaleType: string,
	parallelColumns?: string[] | null
): FieldInfoRequest[] {
	const requests: FieldInfoRequest[] = [];
	const processedFields = new Set<string>();

	for (const alias in select) {
		const fieldValue = select[alias];
		if (fieldValue == null) continue;

		// Handle AutoBinNodes
		if (isBinExpression(fieldValue)) {
			const stats = fieldValue.stats;
			if (!processedFields.has(stats.column)) {
				requests.push({ table, column: stats.column, stats: stats.stats });
				processedFields.add(stats.column);
			}
			continue;
		}

		// Skip RollingAvgNodes — domain derived from query results
		if (isRollingAvgExpression(fieldValue)) continue;

		// Handle regular fields
		if (processedFields.has(String(fieldValue))) continue;

		const exprNode = isNode(fieldValue) ? fieldValue : sqlColumn(String(fieldValue));
		if (isAggregateExpression(exprNode) || isWindowExpression(exprNode)) continue;

		const scaleType =
			alias === 'x' || alias === 'x1' || alias === 'x2'
				? actualXScaleType
				: alias === 'y' || alias === 'y1' || alias === 'y2'
					? actualYScaleType
					: parallelColumns?.includes(alias)
						? 'linear'
						: null;

		// Time scales get their domain from sidecar query in fetchCategoricalDomains,
		// not from fieldInfo (which would return values from the offset column)
		if (isNumericScale(scaleType)) {
			requests.push({ table, column: exprNode, stats: ['min', 'max'] });
			processedFields.add(String(fieldValue));
		}
	}

	return requests;
}

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
		}
		// Window expressions: skip both -- they don't trigger GROUP BY
		// and shouldn't appear in GROUP BY themselves
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
