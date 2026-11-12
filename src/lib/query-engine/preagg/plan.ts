/**
 * Preagg planning: what a preagg table for a mark and a selection source looks
 * like, the SQL that builds and reads it, and the checks that decide whether
 * it still answers. Pure functions over a mark's query descriptor and the
 * categorical identity; the state they work on (each mark's tables, the build
 * queue, row counts) lives in Preagg.
 *
 * The table shape follows @uwdata/mosaic-core 0.21's PreAggregator
 * (packages/mosaic/core/src/preagg/): the active dimensions as GROUP BY
 * columns, sufficient statistics for the aggregates, and a name hashed from
 * the query. Copyright (c) 2023-2025, UW Interactive Data Lab. BSD 3-Clause
 * License; see NOTICE.
 */

import {
	isAggregateExpression,
	isNode,
	collectColumns,
	column,
	and,
	isBetween,
	literal,
	Query,
	collectAggregates,
	sql as sqlTag,
	type ExprNode,
	type WindowNode
} from '@uwdata/mosaic-sql';
import { BITMAP_MIN_IDS, idBitmapPredicate, togglePredicate } from '../toggle-predicate';
import {
	rewriteForPreagg,
	buildBinExpr,
	binsFineEnough,
	BIN_WINDOW_MARGIN,
	type BrushActivation
} from '../sufficient-statistics';
import {
	assembleQuery,
	castNumeric,
	castReal,
	type QueryParts
} from '$lib/components/marks/lifecycle/query-builder';
import type { MarkHandle, QueryParams } from '../MarkHandle.svelte';
import type { CategoricalIdentity, DimValue } from '../categorical-identity';
import type {
	Clause,
	CrossfilterSelection,
	FilterExpr,
	MarkRoute
} from '../CrossfilterSelection.svelte';
import type { QueryDescriptor } from '../QueryEngine';

/** What planning needs from the categorical identity. */
export type PreaggIdentity = Pick<
	CategoricalIdentity,
	| 'idColumn'
	| 'fieldOfIdColumn'
	| 'values'
	| 'dimCovers'
	| 'viewHas'
	| 'sqlFor'
	| 'dimTable'
	| 'identity'
>;

/**
 * How a source selects, one entry per active dimension: a pixel-binned
 * continuous column (`bin`, with the data extent when known, for the size
 * guard), or a categorical field (`value`, keyed by its identity key).
 */
export type ActiveDim =
	| ({ kind: 'bin'; extent?: [number, number] } & BrushActivation)
	| { kind: 'value'; field: string };

/** What activate() needs to know about a source, as FilterGroup sees it at hover time. */
export interface ActivationSource {
	sourceId: string;
	/**
	 * The source's categorical field (identity key), or null for a brush or a
	 * tuple. With the registrations, decides which marks the source would
	 * filter: a mark that reads this field dims by it and needs no table.
	 */
	categoricalKey: string | null;
	dims: ActiveDim[];
	/**
	 * For a source with bin dims: writes its current view, `[d0, d1, pixel
	 * extent]` per bin dim, into `out`. Read on every query, so it must not
	 * allocate.
	 */
	view?: (out: Float64Array) => void;
}

/** What a preagg table was built from. It serves brush queries only while this still holds. */
export interface PreaggBasis {
	/** Query parts, compared by reference ($derived memoization keeps them stable). */
	parts: QueryParts;
	/** The source whose clause the table answers instead of baking in. */
	activeSourceId: string;
	/** What the active dims' columns are: bin column, or value field. A bin
	 *  dim's view is checked separately (binFitsView). */
	dimsKey: string;
	/** The clause objects baked into the table, in selection insertion order.
	 *  Refreshed when new objects turn out to give the same SQL. */
	bakedClauses: Clause[];
	/** The source's current view, for the bin resolution check (bin dims only). */
	view: ((out: Float64Array) => void) | null;
}

/** The filter-independent parts of a preagg table's SELECT. */
export interface PreaggCreation {
	table: string;
	select: Record<string, ExprNode>;
	groupby: ExprNode[];
	orderby: ExprNode[];
	/**
	 * The mark's own row filters (`filter()`), applied to the source rows inside the
	 * build: the table groups them away, so the read could not apply them.
	 */
	where: ExprNode[];
	/**
	 * Fields grouped by value inside and mapped to their ids on the grouped
	 * result: `raw` is the inner column, `alias` the id column, `dim` the dim
	 * table joined on value. Empty for every other table.
	 */
	joins: Array<{ raw: string; alias: string; dim: string }>;
	/**
	 * The mark's padding rows, held in the table so its reads need no padding
	 * (see TransformCompiler.padRows), or null. `rows` is their SELECT over
	 * every channel; the table takes its group channels (`dims`), 0 for every
	 * partial (`partials`: count and sum only, for which 0 adds nothing), and
	 * `__pad` true. Source rows whose bin is NULL are left out (in `where`):
	 * those bins are never drawn, and padding a base read drops them too.
	 */
	pad: { rows: string; dims: string[]; partials: string[] } | null;
}

/** The column marking a preagg table's padding rows; real rows hold false. */
export const PAD_COLUMN = '__pad';

/**
 * How each active dim appears in a preagg table. A `bin` dim is a pixel-bin
 * index over a window (`buildBinExpr`): bins 0 .. bins - 1 from d0, with -1
 * and `bins` for everything outside it. A `value` dim is a column holding the
 * field's ids (`byId`) or its raw values, in the source's field order.
 */
export type ActiveMeta =
	| { kind: 'bin'; alias: string; d0: number; scaleFactor: number; bins: number }
	| { kind: 'value'; field: string; column: string; byId: boolean };

/**
 * A group key of a planned table, for the size guard: how many groups it has
 * (null: unknown), and the one source column it bins, if it bins exactly one,
 * so a key on a column the mark already groups by is not counted twice.
 */
export interface GroupKey {
	column: string | null;
	groups: number | null;
}

export interface PreaggState {
	table: string;
	/** The SELECT the table was created from. Its hash names the table. */
	sql: string;
	basis: PreaggBasis;
	creation: PreaggCreation;
	/** Clause objects already found to give different SQL, so frames that
	 *  still see them go to the base table without rebuilding the SQL. */
	mismatch: Clause[] | null;
	/** Rewritten select expressions that recombine partials at query time. */
	outputSelect: Record<string, ExprNode>;
	/** The active dims as the table holds them, for the query-time filter. */
	activeMeta: ActiveMeta[];
	/** Window channels needing CTE wrapping in the preagg query. */
	windowChannels: Record<string, import('@uwdata/mosaic-sql').WindowNode> | null;
}

/**
 * The preagg table a mark would build for a source's active dims, or null
 * when the mark cannot be pre-aggregated (no aggregates, or an aggregate that
 * does not decompose).
 *
 * A `value` dim's column is resolved per mark:
 * 1. The mark already groups by the field's id (a channel reading only its
 *    id column): nothing is added; the filter goes on that channel.
 * 2. The field's dim covers the mark's base table, so every non-NULL value
 *    has an id: the field is grouped by value inside and mapped to its ids
 *    on the grouped result, a join over thousands of rows rather than the
 *    view's join over every row. A view that already exposes the id column
 *    is grouped by it directly.
 * 3. Otherwise the field's values themselves, filtered with the toggle's own
 *    predicate over that column.
 *
 * Also returns the active dims' group keys, for the size guard.
 */
export function planPreagg(
	descriptor: QueryDescriptor,
	dims: ActiveDim[],
	identity: PreaggIdentity
): {
	creation: PreaggCreation;
	outputSelect: Record<string, ExprNode>;
	activeMeta: ActiveMeta[];
	windowChannels: Record<string, WindowNode> | null;
	activeKeys: GroupKey[];
} | null {
	const { parts, table, baseTable, schema } = descriptor;
	if (!parts.hasAggregates && !parts.hasWindowAggregates) return null;
	// A having() on a preagg table would count its groups, not the source rows, and
	// return the wrong rows without an error. The built-in transforms add none; see
	// TransformCompiler.hasHaving for why, and for what supporting it would take.
	if (descriptor.transformCompiler.hasHaving()) return null;

	// Analyze selectDef for preagg compatibility
	const analysis = rewriteForPreagg(parts.selectDef, parts.passthroughChannels);
	if (!analysis) return null; // unsupported (window/distinct)
	const { preaggCols, outputSelect, preaggGroupBy } = analysis;

	const activeMeta: ActiveMeta[] = [];
	const activeGroupBy: ExprNode[] = [];
	const binOrder: ExprNode[] = [];
	const joins: PreaggCreation['joins'] = [];
	const activeKeys: GroupKey[] = [];

	dims.forEach((dim, i) => {
		const alias = `__active${i}`;
		if (dim.kind === 'bin') {
			const { expr, d0, scaleFactor, bins } = buildBinExpr(
				dim.columnRef,
				dim.domain,
				dim.pixelExtent
			);
			preaggCols[alias] = expr;
			activeGroupBy.push(column(alias));
			binOrder.push(column(alias));
			activeMeta.push({ kind: 'bin', alias, d0, scaleFactor, bins });
			// The window's bins plus the two edge bins, or fewer when the data
			// spans less than the window at this resolution.
			const dataBins = dim.extent
				? Math.ceil((dim.extent[1] - dim.extent[0]) * scaleFactor) + 1
				: Infinity;
			const binned = collectColumns(dim.columnRef);
			activeKeys.push({
				column: binned.length === 1 ? binned[0].column : null,
				groups: Math.min(bins + 2, dataBins)
			});
			return;
		}

		const { field } = dim;
		const channel = idChannelFor(parts.selectDef, field, identity);
		if (channel) {
			// Case 1: already a group key of the mark.
			activeMeta.push({ kind: 'value', field, column: channel, byId: true });
			return;
		}
		// One more group for -1: a value the dim does not hold yet. NULL has an id
		// of its own, counted in the values.
		const idGroups = identity.values(field).length + 1;
		if (identity.dimCovers(field, baseTable)) {
			// Case 2.
			if (table !== baseTable && identity.viewHas(baseTable, field)) {
				preaggCols[alias] = column(identity.idColumn(field));
				activeGroupBy.push(column(alias));
			} else {
				const raw = `__raw${i}`;
				preaggCols[raw] = fieldExpr(identity.sqlFor(field), field);
				activeGroupBy.push(column(raw));
				joins.push({ raw, alias, dim: identity.dimTable(field) });
			}
			activeMeta.push({ kind: 'value', field, column: alias, byId: true });
			activeKeys.push({ column: null, groups: idGroups });
			return;
		}
		// Case 3.
		preaggCols[alias] = fieldExpr(identity.sqlFor(field), field);
		activeGroupBy.push(column(alias));
		activeMeta.push({ kind: 'value', field, column: alias, byId: false });
		activeKeys.push({ column: null, groups: null });
	});

	const pad = analysis.windowChannels ? null : padPlan(descriptor, preaggCols);

	// CAST-wrap dimension preaggCols (bake CAST into the preagg table).
	// Partial-aggregate and active columns stay raw for recombination.
	for (const [ch, expr] of Object.entries(preaggCols)) {
		if (ch.startsWith('__ps') || ch.startsWith('__active') || ch.startsWith('__raw')) continue;
		if (isAggregateExpression(expr)) continue;
		preaggCols[ch] = castNumeric(expr, schema) as ExprNode;
	}

	return {
		creation: {
			table,
			select: preaggCols as Record<string, ExprNode>,
			groupby: [...preaggGroupBy, ...activeGroupBy] as ExprNode[],
			// Sorted by bin columns for fast range scans
			orderby: binOrder,
			where: [...descriptor.transformCompiler.rowFilters(), ...(pad?.where ?? [])],
			joins,
			pad: pad?.pad ?? null
		},
		outputSelect,
		activeMeta,
		windowChannels: analysis.windowChannels,
		activeKeys
	};
}

/**
 * The padding rows a mark's table can hold, or null when its reads must pad
 * themselves: the mark pads nothing, a transform would see the rows differently
 * (TransformCompiler.padRows), or a measure is not a count or a sum. A mean of
 * an empty bin would read 0 / 0 from a padding row, where padding gives 0.
 */
function padPlan(
	descriptor: QueryDescriptor,
	preaggCols: Record<string, ExprNode>
): { pad: NonNullable<PreaggCreation['pad']>; where: ExprNode[] } | null {
	const { parts, transformCompiler } = descriptor;
	for (const expr of Object.values(parts.selectDef)) {
		if (!isNode(expr) || !isAggregateExpression(expr as ExprNode)) continue;
		for (const agg of collectAggregates(expr as ExprNode)) {
			const name = agg.name.toLowerCase();
			if (agg.isDistinct || (name !== 'count' && name !== 'sum')) return null;
		}
	}
	const rows = transformCompiler.padRows(Object.keys(parts.selectDef), {
		groupKeys: parts.groupKeys,
		bins: parts.bins ?? null
	});
	if (!rows) return null;
	const dims: string[] = [];
	const partials: string[] = [];
	for (const [col, expr] of Object.entries(preaggCols)) {
		if (col.startsWith('__ps')) partials.push(col);
		else if (col.startsWith('__active') || col.startsWith('__raw')) continue;
		else if (!isAggregateExpression(expr)) dims.push(col);
	}
	// A filter on the source column, not on the bin: on the bin it would be
	// pushed below the GROUP BY and compute every row's bin twice (measured:
	// half again the build time), where a NULL test on the column is free.
	const sources = new Set(dims.flatMap((col) => parts.bins?.[col]?.source ?? []));
	const where = [...sources].map(
		(source) => sqlTag([`(${source}) IS NOT NULL`] as unknown as TemplateStringsArray) as ExprNode
	);
	return { pad: { rows, dims, partials }, where };
}

/** The mark's channel that is `field`'s id channel (see idFieldOf), or null. */
function idChannelFor(
	selectDef: Record<string, unknown>,
	field: string,
	identity: PreaggIdentity
): string | null {
	for (const [channel, expr] of Object.entries(selectDef)) {
		if (idFieldOf(expr, identity) === field) return channel;
	}
	return null;
}

/**
 * The field whose ids a channel holds, or null. Only the id column itself or
 * castReal of it, the forms marks produce: an id filter on any other
 * expression over the column (say idx % 2) would filter transformed values.
 * Compared as SQL text; runs when a table is planned, not per query.
 */
function idFieldOf(expr: unknown, identity: PreaggIdentity): string | null {
	if (!isNode(expr) || isAggregateExpression(expr as ExprNode)) return null;
	const read = collectColumns(expr as ExprNode);
	if (read.length !== 1) return null;
	const field = identity.fieldOfIdColumn(read[0].column);
	if (field == null) return null;
	const text = String(expr);
	const idColumn = column(read[0].column);
	return text === String(idColumn) || text === String(castReal(idColumn)) ? field : null;
}

/**
 * The mark's own group keys. When every one is a categorical field's id
 * channel, one key per distinct field, sized by its dim. Otherwise one key
 * for the whole mark, sized by its last result's row count (a lower bound:
 * filters or a transform may cut it, and a topN mark groups by an id channel
 * and is counted exactly above), or one group under a limit or before a
 * result; it names the column the mark groups by when there is only one.
 */
export function markKeys(
	descriptor: QueryDescriptor,
	handle: Pick<MarkHandle, 'params' | 'arrowTable'>,
	identity: PreaggIdentity
): GroupKey[] {
	const { parts } = descriptor;
	const fields = new Set<string>();
	const columns = new Set<string>();
	let allIds = true;
	for (const expr of Object.values(parts.selectDef)) {
		if (!isNode(expr) || isAggregateExpression(expr as ExprNode)) continue;
		for (const { column: name } of collectColumns(expr as ExprNode)) columns.add(name);
		const field = idFieldOf(expr, identity);
		if (field == null) allIds = false;
		else fields.add(field);
	}
	if (allIds) {
		return [...fields].map((field) => ({
			column: null,
			groups: identity.values(field).length + 1
		}));
	}
	const rows = handle.params.limit == null ? handle.arrowTable?.numRows : undefined;
	return [{ column: columns.size === 1 ? [...columns][0] : null, groups: rows ?? 1 }];
}

/**
 * The groups a planned table would hold: the mark's own keys (markKeys) and
 * the active dims' combined, or null when an active dim's cardinality is
 * unknown. Keys multiply, except that a field or column is counted once: a
 * mark with x and fill on the same field has that field's groups, not their
 * square, and a bin dim on a column the mark already groups by adds its bins
 * to that key's (each pixel bin falls in about one of the mark's bins)
 * instead of multiplying.
 */
export function estimateGroups(markKeys: GroupKey[], activeKeys: GroupKey[]): number | null {
	if (activeKeys.some((key) => key.groups == null)) return null;
	const merged = new Set<GroupKey>();
	let groups = 1;
	for (const key of markKeys) {
		const same =
			key.column == null
				? undefined
				: activeKeys.find((active) => active.column === key.column && !merged.has(active));
		if (same) merged.add(same);
		groups *= key.groups! + (same?.groups ?? 0);
	}
	for (const key of activeKeys) if (!merged.has(key)) groups *= key.groups!;
	return groups;
}

/**
 * Whether the clauses baked into a preagg table are still the ones in force.
 * Runs on every brush frame. Clause references are compared first, without
 * allocating. A changed reference may still mean the same filter (a Toggle
 * re-synced with the same values, a clause removed and re-added), so on a
 * mismatch the table's SQL is rebuilt from the current clauses and compared.
 * Once that fails, frames that still see the same clauses skip the rebuild.
 */
export function bakedClausesHold(
	route: MarkRoute,
	selection: CrossfilterSelection,
	state: PreaggState
): boolean {
	const { basis } = state;
	const { activeSourceId } = basis;
	if (selection.bakedClausesMatch(route, activeSourceId, basis.bakedClauses)) return true;
	if (state.mismatch && selection.bakedClausesMatch(route, activeSourceId, state.mismatch)) {
		return false;
	}

	const current = selection.bakedClauses(route, activeSourceId);
	const sql = preaggSelectSQL(state.creation, selection.bakedPredicates(route, activeSourceId));
	if (sql === state.sql) {
		basis.bakedClauses = current;
		state.mismatch = null;
		return true;
	}
	state.mismatch = current;
	return false;
}

/**
 * The query a mark runs on a preagg table, or null when the table cannot
 * answer it (a brush end past its window, a toggled value with no id).
 * Builds modified QueryParts from the stored outputSelect + bin filters,
 * then delegates to assembleQuery().
 */
export function preaggQuerySQL(
	route: MarkRoute,
	descriptor: QueryDescriptor,
	selection: CrossfilterSelection,
	preagg: PreaggState,
	params: QueryParams,
	identity: PreaggIdentity
): string | null {
	const { activeMeta, outputSelect, windowChannels } = preagg;

	const { parts, transformCompiler } = descriptor;

	// --- The active source's clause as a filter on the active columns. None
	// when it has no clause (an empty toggle: every category) or does not
	// filter this mark.
	const filters: ExprNode[] = [];
	const activeSourceId = preagg.basis.activeSourceId;
	const clause = selection.get(activeSourceId);
	if (clause && selection.applies(activeSourceId, clause, route)) {
		// A drag frame runs this per mark: nothing below allocates for a brush
		// beyond its filter, so the value arrays are created only when needed.
		let binCount = 0;
		for (const meta of activeMeta) if (meta.kind === 'bin') binCount++;
		let bin = 0;
		let valueExprs: ExprNode[] | null = null;
		let valueMeta: Array<{ field: string; byId: boolean }> | null = null;
		for (const meta of activeMeta) {
			if (meta.kind === 'value') {
				(valueExprs ??= []).push(column(meta.column));
				(valueMeta ??= []).push(meta);
				continue;
			}
			// Interval1D: value = [lo, hi]; Interval2D: [[xLo, xHi], [yLo, yHi]]
			const range = (binCount === 1 ? clause.value : (clause.value as unknown[])[bin]) as [
				number,
				number
			];
			bin++;
			const binLo = Math.floor((range[0] - meta.d0) * meta.scaleFactor);
			const binHi = Math.floor((range[1] - meta.d0) * meta.scaleFactor);
			// A brush end past the table's window falls in an edge bin, which
			// holds everything beyond it: not answerable here, so the base table.
			if (!(binLo >= 0 && binHi < meta.bins)) return null;
			filters.push(isBetween(column(meta.alias), [literal(binLo), literal(binHi)]) as ExprNode);
		}
		if (valueExprs && valueMeta) {
			// A toggle's clause holds tuples in its field order. Id columns
			// filter by id (the NULL category has one); a value with no id (not in
			// the dim yet) cannot be expressed, so this query goes to the base
			// table instead.
			const tuples: unknown[][] = [];
			for (const tuple of clause.value as unknown[][]) {
				const mapped: unknown[] = [];
				for (let i = 0; i < valueMeta.length; i++) {
					const { field, byId } = valueMeta[i];
					const v = byId ? identity.identity(field).ids.get(tuple[i] as DimValue) : tuple[i];
					if (v === undefined) return null;
					mapped.push(v);
				}
				tuples.push(mapped);
			}
			// One field by id, and many of them (a click on a large Other): a
			// constant-size bitmap rather than a long IN list, which DuckDB spends
			// most of its time parsing. Measured on a preagg table: 1 ms against
			// 20 ms for IN of 9 000 ids.
			const only = valueMeta.length === 1 ? valueMeta[0] : null;
			if (only?.byId && tuples.length > BITMAP_MIN_IDS) {
				filters.push(
					idBitmapPredicate(
						valueExprs[0],
						tuples.map((t) => t[0] as number),
						identity.identity(only.field).values.length
					)
				);
			} else {
				filters.push(togglePredicate(valueExprs, tuples));
			}
		}
	}

	// --- Build selectDef: CAST recombined aggregates; dimensions are already
	// CAST in the preagg table; windowed channels are CAST by the outer CTE.
	const castSelect: Record<string, unknown> = {};
	const preaggGroupBy: ExprNode[] = [];
	const preaggGroupKeys: string[] = [];
	for (const [ch, expr] of Object.entries(outputSelect)) {
		if (!isAggregateExpression(expr)) {
			castSelect[ch] = expr;
			preaggGroupBy.push(column(ch));
			preaggGroupKeys.push(ch);
		} else if (windowChannels && ch in windowChannels) {
			castSelect[ch] = expr;
		} else {
			castSelect[ch] = castReal(expr);
		}
	}

	// A table holding its padding: those rows pass whatever the brush says, and
	// the read's GROUP BY folds them into the real rows of the same group.
	if (preagg.creation.pad && filters.length > 0) {
		filters.splice(
			0,
			filters.length,
			sqlTag`(${column(PAD_COLUMN)} OR ${and(filters)})` as ExprNode
		);
	}

	const preaggParts: QueryParts = {
		selectDef: castSelect,
		nonAggregateGroupBy: preaggGroupBy,
		hasAggregates: true,
		groupKeys: preaggGroupKeys,
		// The table keeps the bin channels as columns of the same bins, so the
		// read pads exactly as the base read does, or is padded already.
		bins: parts.bins,
		padded: !!preagg.creation.pad,
		hasWindowAggregates: false,
		hasSQLTransforms: parts.hasSQLTransforms,
		orderChannels: parts.orderChannels,
		aliasMap: parts.aliasMap,
		passthroughChannels: parts.passthroughChannels,
		// nulls="drop", read through this select: each dropped channel is a group
		// key, so the table keeps NULL as its own group, and dropping that group
		// here removes exactly what the base scan would have left out.
		nullDrops: parts.nullDrops
	};

	return assembleQuery({
		table: preagg.table,
		parts: preaggParts,
		filter: filters,
		transformCompiler,
		// The table was built with them.
		skipRowFilters: true,
		limit: params.limit,
		window: windowChannels ? { channels: windowChannels, cteName: '__preagg_cte' } : null
	}).toString();
}

/** A preagg table's SELECT. Build and validity check share it, so equal SQL means an equal table. */
export function preaggSelectSQL(creation: PreaggCreation, filters: FilterExpr[]): string {
	const pad = creation.pad;
	if (!pad) return realRowsSQL(creation, filters, true);
	// By name: the padding rows name only what they set, and the brush and
	// value columns they leave out come back NULL. Ordered once, outside.
	const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
	const padRows =
		`SELECT ${pad.dims.map((col) => `p.${quote(col)}`).join(', ')}` +
		pad.partials.map((col) => `, 0 AS ${quote(col)}`).join('') +
		`, true AS ${quote(PAD_COLUMN)} FROM (${pad.rows}) AS p`;
	const order = creation.orderby.length ? ` ORDER BY ${creation.orderby.join(', ')}` : '';
	return (
		`SELECT * FROM (SELECT *, false AS ${quote(PAD_COLUMN)} FROM (${realRowsSQL(creation, filters, false)}) AS r` +
		` UNION ALL BY NAME ${padRows})${order}`
	);
}

/** The table's real rows: the mark's groups over the source rows. */
function realRowsSQL(creation: PreaggCreation, filters: FilterExpr[], ordered: boolean): string {
	const query = Query.from(creation.table).select(creation.select).groupby(creation.groupby);
	const where = [...creation.where, ...(filters as ExprNode[])];
	if (where.length > 0) query.where(and(where));
	if (creation.joins.length === 0) {
		return (ordered ? query.orderby(creation.orderby) : query).toString();
	}

	// Map fields grouped by value to their ids on the grouped result: a join
	// over the table's groups, not over every source row. The filters stay in
	// the inner query, where the source's columns are in scope.
	const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
	const raws = creation.joins.map((j) => quote(j.raw)).join(', ');
	const ids = creation.joins
		.map((j, k) => `COALESCE(d${k}.id, -1) AS ${quote(j.alias)}`)
		.join(', ');
	const joins = creation.joins
		.map((j, k) => `LEFT JOIN ${quote(j.dim)} AS d${k} ON p.${quote(j.raw)} = d${k}.value`)
		.join(' ');
	const order =
		ordered && creation.orderby.length ? ` ORDER BY ${creation.orderby.join(', ')}` : '';
	return `SELECT p.* EXCLUDE (${raws}), ${ids} FROM (${query}) AS p ${joins}${order}`;
}

/**
 * What the active dims' columns are: bin column, or value field. A bin dim's
 * domain and pixel extent are left out: a table built at another view still
 * answers it while it fits that view (binFitsView).
 */
export function activeDimsKeyOf(dims: ActiveDim[]): string {
	return dims.map((d) => (d.kind === 'bin' ? `bin|${d.columnRef}` : `value|${d.field}`)).join(';');
}

/**
 * Whether one bin dim of a table suits a view of [v0, v1] over `pixelExtent`:
 * its bins are fine enough for the pixels (the query-time rule), and the view
 * sits at least half a margin inside the binned window. A small pan or zoom
 * out keeps the table; a pan of more than half a viewport, a zoom out past
 * the window, or a zoom in past the built resolution rebuilds it around the
 * new view, so the brushes drawn there stay inside the window. Unknown
 * numbers (NaN) pass.
 */
export function binFitsView(
	meta: Extract<ActiveMeta, { kind: 'bin' }>,
	v0: number,
	v1: number,
	pixelExtent: number
): boolean {
	if (!binsFineEnough(meta.scaleFactor, v1 - v0, pixelExtent)) return false;
	// The window is the built view plus BIN_WINDOW_MARGIN views each side.
	const width = meta.bins / meta.scaleFactor;
	const inset = ((width / (1 + 2 * BIN_WINDOW_MARGIN)) * BIN_WINDOW_MARGIN) / 2;
	return !(v0 < meta.d0 + inset || v1 > meta.d0 + width - inset);
}

/** A field as SQL: the text its identity records, or the column of that name. */
function fieldExpr(sqlText: string | undefined, field: string): ExprNode {
	return sqlText
		? (sqlTag([sqlText] as unknown as TemplateStringsArray) as ExprNode)
		: column(field);
}

/** 32-bit FNV-1a hash. */
export function fnvHash(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}
