/**
 * Transform Pipeline for Mosaic-based visualizations
 *
 * Transforms are divided into two stages:
 * - SQL: Modify the Query AST (WHERE, HAVING, LIMIT, ORDER BY, CTE wrapping)
 * - JS: Process data via the DataAccessor interface (zero-copy on Arrow data)
 */

import { Query, column, sql as sqlTag } from '@uwdata/mosaic-sql';
import type { ExprNode, SelectQuery } from '@uwdata/mosaic-sql';
import type {
	ChannelIdentity,
	SqlTransform,
	JsTransform,
	Transform,
	MarkConfig,
	NormalizedSortConfig,
	ScaleMap
} from '$lib/types';
import type { DataAccessor } from '$lib/data/DataAccessor';

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
// SQL only. Ranks, then filters to the top N or collapses the rest into Other.
// Runs in the database like every category-reducing step, and — unlike a
// client-side pass — ahead of `dense()`, which is what lets it animate.
// -----------------------------------------------------------------------------

interface TopNOptions {
	/** Value channel to rank by. Default: the mark's value axis (y, or x for barx). */
	by?: string;
	/** Collapse everything past the cutoff into one Other row per series. */
	includeOthers?: boolean;
}

/**
 * Keep the top `n` categories by value.
 *
 * `n` may be a getter — `topN(() => count)` — read each time the query is
 * assembled. That is what lets a changing count animate: `topN(count)` with a
 * different number is a different transform, and a mark handed different
 * transforms is rebuilt, which throws away the bars on screen. A getter keeps the
 * transform, and the mark re-queries when what it reads changes, the way it does
 * for `limit`.
 */
export function topN(n: number | (() => number), options: TopNOptions = {}): SqlTransform {
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
 * channel is the measure, which is the group".
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

/**
 * The column a ranking transform uses to tell the band axis what its ranking
 * was: topN's, and the `sort` prop's through `rank()`. One column, so the axis
 * has one reader whichever transform ranked; when both run, `rank()` runs last
 * and its order wins while topN's membership stands.
 *
 * Display order is a property of the DATA, not of the order rows arrive in.
 * Row order is not preserved through a wrapping subquery, and it is also
 * already spoken for: a connected mark needs rows ordered by x to draw its
 * polyline, and `domain-registration.ts` says as much where it declines to
 * treat row order as a sort order. Carrying the rank as a value lets both
 * consumers have what they need at once.
 *
 * `__dplot_`-prefixed so #writeTooltipTable's existing filter hides it, like
 * the identity index columns in the same result.
 */
export const RANK_COLUMN = '__dplot_rank';

/**
 * Give every category in the dim a row, at zero past the cutoff.
 *
 * This is what makes a departing category animate instead of disappearing: it
 * still has a row, its measure runs to 0, and enter/leave becomes an ordinary
 * value change on a channel that already exists — which is what the animation
 * contract says it should be.
 *
 * **The cutoff stays INSIDE the join.** The join restores ROWS, not VALUES, so
 * an excluded category comes back at 0 rather than at its real aggregate. That
 * is what makes a leaving bar shrink to nothing, and it is also why
 * `includeOthers` cannot double-count: Other carries the sum, and the
 * categories folded into it carry zero.
 *
 * Column rules, and each one is load-bearing:
 * - the band channel becomes `d.id`, so it is present for every category;
 * - a channel carrying a category id from the SAME dim as the band is filled
 *   from the dim, because its value is that category's own id — which is what
 *   keeps a departing bar its colour while it shrinks;
 * - another group key (a series, a facet) is enumerated from its own dim, so a
 *   missing PAIR is padded too, under its real id;
 * - a category id from another field that is not a key gets -1, the absent
 *   sentinel, never 0, which is a real category;
 * - the rank becomes NaN on every padded row, which is how a topN axis knows
 *   that row is not displayed;
 * - every other channel is COALESCEd to 0, so a padded row has zero extent
 *   rather than a NaN one, which would be discarded rather than shrunk.
 *
 * Written with `sqlTag` because mosaic-sql's SelectQuery has no join — `from()`
 * takes table expressions and a multi-expression `from` is a cross join, which
 * is an INNER semantic and drops precisely the rows this exists to keep. A raw
 * FROM inside a transform's `apply()` body is safe by construction — it is not a
 * channel expression, so nothing downstream tries to analyse it. The unaliased
 * `Query.from(sqlTag...)` form is deliberate, because the object form appends
 * `AS "<key>"` after the ON clause and produces a syntax error.
 *
 * NOT ORDERED HERE. A bar mark stacks by default, so this is wrapped, and a
 * subquery's ORDER BY does not bind the outer query. It publishes `alignment`
 * instead, and the query assembler orders the outermost query by it.
 */
function densify(inner: SelectQuery, aliases: string[], plan: DensePlan): SelectQuery {
	const { band, dim, cross } = plan;
	const crossAlias = new Map(cross.map(([key], i) => [key, `k${i}`]));
	const select: Record<string, ExprNode> = {};
	for (const alias of aliases) {
		const crossed = crossAlias.get(alias);
		if (alias === band) {
			select[alias] = sqlTag`d."id"` as ExprNode;
		} else if (crossed) {
			// Another group key, enumerated from its own dim: the padded row for a
			// missing (category, series) pair carries that series' real id.
			select[alias] = rawSql(`${crossed}."id"`) as ExprNode;
		} else if (plan.identity[alias]?.dim === dim) {
			// Same dim as the band, so this channel IS the category — the ordinary
			// "colour the bars by their own category" chart. Its value for a row
			// with no data is not unknown, it is that category's id, so take it
			// from the dim like the band does.
			//
			// This is what keeps a DEPARTING bar its colour. It is still on screen
			// while it shrinks, and a sentinel would turn it grey on the frame its
			// data disappeared — the one frame where the colour matters most.
			select[alias] = sqlTag`d."id"` as ExprNode;
		} else if (plan.identity[alias]) {
			// A category id from some OTHER field that is not a group key — an
			// aggregate over ids. There is no correct value for a row with no data,
			// so the absent sentinel it is. Never 0, which is a real category: it
			// would enter the colour scale's domain, shift every palette rank after
			// it, and repaint bars that had not changed.
			select[alias] = sqlTag`COALESCE(a.${column(alias)}, -1)` as ExprNode;
		} else {
			// A measure. 0 is the point: it is what makes a departing bar shrink to
			// nothing rather than vanish.
			select[alias] = sqlTag`COALESCE(a.${column(alias)}, 0)` as ExprNode;
		}
	}
	// Only when a ranking transform actually published one. Most marks have no
	// rank column, and projecting it unconditionally is a binder error.
	//
	// It cannot be left to the loop above either: that coalesces to 0, and 0 is
	// the BEST rank, so every padded row would sort to the front.
	if (aliases.includes(RANK_COLUMN)) {
		// NaN, not NULL and not 0, for a padded row — "returned but not displayed".
		//
		// This is the ONLY thing that keeps a padded row off a topN axis: past the
		// cutoff, a synthetic id another mark reserved, an id from another table
		// sharing the field's dim. All three are rows the join added, and all
		// three get NaN here. It survives to JS because every channel coalesces
		// NULL to NaN: DataAccessor's zero-copy path requires nullCount == 0, and a
		// nullable column would arrive with whatever its values buffer holds —
		// usually 0, the best rank.
		select[RANK_COLUMN] = sqlTag`COALESCE(CAST(a.${column(
			RANK_COLUMN
		)} AS REAL), 'NaN'::REAL)` as ExprNode;
	}

	// Every other group key is crossed in, so a missing PAIR comes back, not only
	// a missing category. Each key's ids get -1 appended: a row whose series is
	// NULL carries -1, and a join over the dim's ids alone would drop it.
	const joins = cross
		.map(
			([, keyDim], i) =>
				` CROSS JOIN (SELECT "id" FROM ${quoteTable(keyDim)} UNION ALL SELECT -1) AS k${i}`
		)
		.join('');
	const on = [
		`a.${column(band)} = d."id"`,
		...cross.map(([key], i) => `a.${column(key)} = k${i}."id"`)
	].join(' AND ');
	return Query.from(
		rawSql(`${quoteTable(dim)} AS d${joins} LEFT JOIN (${inner}) AS a ON ${on}`)
	).select(select);
}

/**
 * Most padded rows `dense()` will produce before refusing.
 *
 * The result is band x every other key's dim, so it multiplies. Measured on
 * native DuckDB over a 1M-row fact table: 10k padded rows cost under ~10 ms more
 * than the sparse query, 50k about 50 ms, and 1M (5000 categories x 20 series x
 * 10 facets) over a second. 10k covers a 5000-category topN and 500 categories
 * x 20 series. Past it the mark snaps instead of morphing, which is what it did
 * before any of this existed.
 */
export const DENSE_ROW_LIMIT = 10_000;

interface DensePlan {
	/** The channel joined against its dim, and that dim. */
	band: string;
	dim: string;
	/** Every other group key with a dim of its own, crossed in: [channel, dim]. */
	cross: [string, string][];
	identity: Record<string, ChannelIdentity>;
}

/**
 * Whether `dense()` applies to a query with these aliases, and how.
 *
 * The one place its conditions live. Refuses — returns null — when padding
 * would make a claim that is false:
 *
 * - **Not grouped.** A raw mark has many rows per category; padding it aligns
 *   nothing. Raw marks show rows of a static file and have nothing to morph.
 * - **Not exactly one dimmed positional axis** among the aliases. A heatmap
 *   would need both, which is the cross product again, and is not built.
 * - **A group key with no dim.** Its values cannot be enumerated, so its
 *   missing combinations cannot be padded; padding it as a measure would
 *   misalign rather than align.
 * - **Too many rows.** See DENSE_ROW_LIMIT.
 */
function densePlan(
	aliases: string[],
	config: MarkConfig | undefined,
	enabled: boolean,
	reported?: Set<string>
): DensePlan | null {
	// Say once, per mark, why a mark that LOOKS like it should morph will not.
	//
	// A refusal is silent on screen: the bars still draw, with the right
	// values, and simply snap between updates instead of travelling. That is
	// the failure this whole line of work is easiest to miss — safer than
	// wrong numbers and much harder to notice — so the reason is stated rather
	// than left to be re-derived from these conditions.
	//
	// Only for a mark that plainly meant to: one dimmed positional axis, and
	// then something else in the way. The silent returns below are the cases
	// where padding was never on the table — a scatter with two continuous
	// axes, a raw ungrouped mark, a mark whose identity has not landed yet —
	// and announcing those would be noise on every chart in the library.
	const say = (reason: string) => {
		if (!reported) return;
		const key = `${config?.table ?? '?'}:${reason}`;
		if (reported.has(key)) return;
		reported.add(key);
		console.info(
			`[dense] ${reason} Categories on this mark will snap between updates ` +
				`rather than morphing, and a category leaving will vanish rather than shrink out.`
		);
	};

	if (!enabled) return null;

	const identity = config?.identity;
	if (!identity) return null;

	// Stated by whoever built the select, because it cannot be recovered from
	// the query by the time this runs: topN has already wrapped it, and the
	// GROUP BY is several levels down.
	const groupKeys = config?.groupKeys;
	if (!groupKeys) return null;

	const candidates = aliases.filter((ch) => identity[ch]?.positional);
	if (candidates.length !== 1) {
		if (candidates.length > 1) {
			say(
				`${candidates.length} categorical positional axes (${candidates.join(', ')}), and ` +
					`padding is defined for one.`
			);
		}
		return null;
	}
	const band = candidates[0];
	const { dim, size } = identity[band];
	if (!dim || !groupKeys.includes(band)) {
		if (!dim) say(`"${band}" has no dim to join against.`);
		else say(`"${band}" is not a GROUP BY key, so its rows are not one per category.`);
		return null;
	}

	const cross: [string, string][] = [];
	// Padded rows: the band's categories, times each crossed key's ids plus -1.
	let rows = size;
	for (const key of groupKeys) {
		if (key === band || !aliases.includes(key)) continue;
		const keyIdentity = identity[key];
		if (!keyIdentity) {
			say(`the group key "${key}" has no dim, so its missing combinations cannot be enumerated.`);
			return null;
		}
		// A key from the band's own dim is the category again, not a new axis.
		if (keyIdentity.dim === dim) continue;
		cross.push([key, keyIdentity.dim]);
		rows *= keyIdentity.size + 1;
	}
	if (rows > DENSE_ROW_LIMIT) {
		say(
			`padding would produce about ${rows} rows, over the ${DENSE_ROW_LIMIT} limit ` +
				`(${size} categories${cross.length > 0 ? ` across ${cross.length + 1} group keys` : ''}).`
		);
		return null;
	}

	return { band, dim, cross, identity };
}

/**
 * Return a row for every category, not only the ones that survived.
 *
 * Added automatically to any mark with a categorical axis, and the reason it is
 * a default rather than an opt-in is that the alternative is a silent
 * discontinuity: a category filtered down to no rows simply drops out of the
 * GROUP BY, so its bar disappears between one update and the next with nothing
 * to animate and no way for a consumer to tell it apart from a category that
 * was never there.
 *
 * With it, absence is a VALUE — zero — so a bar shrinks to nothing and a
 * returning one grows back, and the row set is the same size and in the same
 * order on every update. That second property is what lets a mark hand its rows
 * to the GPU as an array indexed by category and morph between two of them.
 *
 * With a series or a facet, "every category" means every COMBINATION of group
 * key values, since those are what the rows are. When it refuses and why is
 * `densePlan`.
 */
export function dense(options: { enabled?: boolean } = {}): SqlTransform {
	const enabled = options.enabled !== false;
	// Per transform instance, so per mark: a refusal is reported once, not once
	// per query assembled. Both entry points below share it.
	const reported = new Set<string>();
	return {
		stage: 'sql',
		type: 'dense',
		spec: { transform: 'dense', ...(enabled ? {} : { enabled: false }) },
		/**
		 * The band, then every crossed key: the rows are exactly their cross
		 * product. Decided by the same plan `apply()` joins on, so a mark asking
		 * and the query agreeing are one derivation, not two.
		 */
		alignment(aliases: string[], config?: MarkConfig): string[] | null {
			const plan = densePlan(aliases, config, enabled, reported);
			return plan ? [plan.band, ...plan.cross.map(([key]) => key)] : null;
		},
		apply(query: SelectQuery, config?: MarkConfig) {
			const aliases = getSelectAliases(query);
			const plan = densePlan(aliases, config, enabled, reported);
			return plan ? densify(query, aliases, plan) : query;
		},
		describe() {
			return 'Dense categories';
		}
	};
}

/**
 * Insert `dense()` where it has to run: after anything that drops categories,
 * before anything that wraps the result.
 *
 * Before a stack in particular. Stacking after densifying is correct — a zero
 * row contributes zero to a cumulative sum — while densifying after stacking
 * would join one row per category onto a result that has one row per category
 * PER SERIES, and collapse the series.
 */
export function withDenseCategories(transforms: Transform[], enabled = true): Transform[] {
	if (!enabled) return transforms;
	if (transforms.some((t) => t.type === 'dense')) return transforms;
	// A JS-engine pipeline computes membership client-side and never sees the
	// SQL path, so a SQL transform in front of it would be applied to a query
	// whose result it does not produce.
	if (transforms.some((t) => t.stage === 'js')) return transforms;

	const stackAt = transforms.findIndex((t) => t.type === 'stack');
	const d = dense();
	if (stackAt === -1) return [...transforms, d];
	return [...transforms.slice(0, stackAt), d, ...transforms.slice(stackAt)];
}

// -----------------------------------------------------------------------------
// rank — order a band axis by a measure, published as a column
// -----------------------------------------------------------------------------

/**
 * Rank every category of a band axis by a measure, in the query that draws it.
 *
 * This is what a mark's `sort` prop becomes. It used to be a sidecar: a second
 * query against the unfiltered base table, whose result was handed to the
 * scale as a preferred order. That ranked the whole table while the chart
 * showed a filtered one — a racing bar chart ordered by all-time totals rather
 * than by the step on screen — and it was a second route for display order to
 * reach the axis, beside the one topN already used: a rank column in the
 * result, read by the axis as a value. This is that route, for `sort`.
 *
 * The measure is aggregated per category first, so a category gets one rank
 * however many rows it has. SUM over a grouped query, because a series splits a
 * category across rows and its total is what should rank it. MIN or MAX over an
 * ungrouped one, because those rows are raw values and the extreme is what an
 * ORDER BY would have put first. Ties break on the band id, so the order is
 * deterministic.
 *
 * Runs LAST, after `dense()` and any stack. A padded row is a real category at
 * zero and belongs on a sorted axis exactly as on an unsorted one, so it is
 * ranked with the rest. When topN has already ranked and `dense()` has marked
 * the rows past its cutoff NaN, those stay NaN: rows are partitioned by whether
 * they are displayed and only the displayed partition is re-ranked, so
 * membership stays topN's and order becomes the sort's. An Other bucket ranks
 * last whatever its total; it is a remainder, not a category.
 *
 * `sort` may be a getter, read when the query is assembled, so changing it
 * re-queries instead of rebuilding the mark — the contract `topN(() => k)` set.
 * With no sort, or on an axis that carries no identity (a continuous x on a
 * line, or an axis whose dim has not arrived), the query passes through
 * untouched.
 */
export function rank(sort: NormalizedSortConfig | (() => NormalizedSortConfig)): SqlTransform {
	const current = typeof sort === 'function' ? sort : () => sort;
	return {
		stage: 'sql',
		type: 'rank',
		// A getter, so reading it from a reactive context tracks the sort.
		get spec() {
			const s = current();
			return s
				? { transform: 'rank', axis: s.axis, by: s.channel, direction: s.direction }
				: { transform: 'rank' };
		},
		apply(query: SelectQuery, config?: MarkConfig) {
			const s = current();
			if (!s) return query;
			const aliases = getSelectAliases(query);
			const band = s.axis;
			// Only a band axis with identity has categories to rank. Before the
			// dim arrives the channel carries raw values, and a continuous axis
			// carries no categories at all; both pass through.
			if (!aliases.includes(band) || !config?.identity?.[band]?.positional) return query;
			// The sort channel resolved the way the mark lifecycle resolves an
			// axis: a point mark has y, an extent mark y2 or y1.
			const by = [s.channel, `${s.channel}2`, `${s.channel}1`].find((a) => aliases.includes(a));
			if (!by) return query;

			const bandCol = column(band);
			const grouped = !!config.groupKeys;
			const perCategory = grouped
				? sqlTag`SUM(${column(by)}) OVER (PARTITION BY ${bandCol})`
				: s.direction === 'desc'
					? sqlTag`MAX(${column(by)}) OVER (PARTITION BY ${bandCol})`
					: sqlTag`MIN(${column(by)}) OVER (PARTITION BY ${bandCol})`;
			const totals = Query.from({ __rank_base: query }).select({
				...passthroughSelect(aliases),
				__dplot_rank_measure: perCategory as ExprNode
			});

			const measure = column('__dplot_rank_measure');
			const otherId = config.identity[band].otherId;
			const order = [
				// Other last, whatever it sums to.
				...(otherId != null ? [sqlTag`(${bandCol} = ${otherId}) ASC`] : []),
				s.direction === 'desc' ? sqlTag`${measure} DESC` : sqlTag`${measure} ASC`,
				sqlTag`${bandCol} ASC`
			];
			const orderBy = rawSql(order.map((o) => String(o)).join(', '));

			// A rank already in the result is topN's, and a NaN there is a row
			// dense() padded past the cutoff: returned so its bar can shrink out,
			// never displayed. That stays NaN, and the displayed rows are ranked
			// among themselves.
			const prior = aliases.includes(RANK_COLUMN) ? column(RANK_COLUMN) : null;
			const ranked = prior
				? sqlTag`CASE WHEN isnan(CAST(${prior} AS REAL)) THEN 'NaN'::REAL ELSE CAST(DENSE_RANK() OVER (PARTITION BY isnan(CAST(${prior} AS REAL)) ORDER BY ${orderBy}) AS REAL) END`
				: sqlTag`CAST(DENSE_RANK() OVER (ORDER BY ${orderBy}) AS REAL)`;

			return Query.from({ __rank_measured: totals }).select({
				...passthroughSelect(aliases),
				[RANK_COLUMN]: ranked as ExprNode
			});
		},
		describe() {
			const s = current();
			return s ? `Sort ${s.axis} by ${s.channel} ${s.direction}` : 'Sort (none)';
		}
	};
}

/**
 * Give a mark's `sort` prop its transform. Placed last among the SQL
 * transforms — after topN, `dense()` and a SQL stack, whose output it ranks —
 * and ahead of any JS transform, which the staging rule requires.
 */
export function withRanking(
	transforms: Transform[],
	sort: NormalizedSortConfig | (() => NormalizedSortConfig)
): Transform[] {
	if (transforms.some((t) => t.type === 'rank')) return transforms;
	const r = rank(sort);
	const jsAt = transforms.findIndex((t) => t.stage === 'js');
	if (jsAt === -1) return [...transforms, r];
	return [...transforms.slice(0, jsAt), r, ...transforms.slice(jsAt)];
}

/** A bare table name, quoted. The dim name comes from the engine, not a user. */
function quoteTable(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Engine-built SQL text as a fragment. Never user input. */
function rawSql(text: string) {
	return sqlTag([text] as unknown as TemplateStringsArray);
}

function topNSQL(count: number | (() => number), options: TopNOptions): SqlTransform {
	const current = typeof count === 'number' ? () => count : count;
	return {
		stage: 'sql',
		type: 'topN',
		// A getter, so it states the count as it is now — and so reading it from a
		// reactive context tracks whatever the count reads.
		get spec() {
			return {
				transform: 'topN',
				n: current(),
				...(options.by ? { by: options.by } : {}),
				...(options.includeOthers ? { includeOthers: true } : {})
			};
		},
		apply(query: SelectQuery, config?: MarkConfig) {
			// Read once per query: every use below must agree on it.
			const n = current();
			const aliases = getSelectAliases(query);
			const { by, band, series } = resolveTopNColumns(aliases, options, config);

			// A NULL category ranks after every real one. A band axis cannot draw it
			// (its id is -1, which the scale has no value for and the shader
			// discards), so ranking it by its measure spent a top-n slot on a bar
			// that never appears: n - 1 bars. Last, it only takes a slot when fewer
			// than n real categories exist, and with includeOthers it folds into
			// Other, which is where "the rest" belongs.
			const nullLast = config?.identity?.[band]
				? sqlTag`(${column(band)} = -1) ASC`
				: sqlTag`(${column(band)} IS NULL) ASC`;

			let ranked: SelectQuery;
			if (series) {
				// Grouped: rank CATEGORIES by their total across every series, so
				// every row of a category shares its rank.
				//
				// Published as a column like the simple path, and for the same two
				// reasons. The axis reads its order from it — row order does not
				// survive the stack wrapping this. And a padded row from `dense()`
				// is kept off the axis by its rank being NaN, which only works if
				// there is a rank to be NaN.
				//
				// DENSE_RANK over (total, band) so a tie still yields exactly n
				// categories, deterministically.
				const totals = Query.from({ __topn_base: query }).select({
					...passthroughSelect(aliases),
					__dplot_topn_total: sqlTag`SUM(${column(by)}) OVER (PARTITION BY ${column(band)})`
				});
				ranked = Query.from({ __topn_totals: totals }).select({
					...passthroughSelect(aliases),
					[RANK_COLUMN]: sqlTag`DENSE_RANK() OVER (ORDER BY ${nullLast}, "__dplot_topn_total" DESC, ${column(band)})`
				});
			} else {
				// Simple: rank rows by value.
				ranked = Query.from({ __topn_base: query }).select({
					...passthroughSelect(aliases),
					[RANK_COLUMN]: sqlTag`ROW_NUMBER() OVER (ORDER BY ${nullLast}, ${column(by)} DESC)`
				});
			}

			// The rank stays in the output, and that is the whole mechanism: the
			// band axis reads it as a VALUE instead of inferring the ranking from
			// the order the rows happen to arrive in.
			//
			// An earlier attempt ordered the rows instead (`40e4132`). It could
			// not work, and the reason generalises: a bar mark stacks by default,
			// so this query is immediately wrapped by stackSQL, and an ORDER BY in
			// a subquery does not bind the outer query — which here is a window
			// PARTITIONed by the band column, so the surviving order was the
			// window operator's, keyed by dim id. That commit's claim that
			// "connected marks keep their x-ordering as that secondary key" was
			// wrong too: ranks are unique, so a secondary key never fires.
			//
			// A value survives all of it. stackSQL projects
			// passthroughSelect(getSelectAliases(query)), so it carries this
			// column through without knowing it exists, and the same holds for any
			// future wrapping transform.
			//
			// The `__dplot_` prefix is load-bearing: #writeTooltipTable filters
			// exactly that prefix, so the rank cannot leak into a tooltip.
			//
			// Not densified here. Keeping a row for every category is not topN's
			// business — an ordinary bar chart under a crossfilter loses rows the
			// same way, when a category filters down to nothing and drops out of
			// the GROUP BY. `dense()` does it for both, and runs after this.
			const otherId = config?.identity?.[band]?.otherId;
			if (options.includeOthers && otherId != null) {
				return collapseIntoOther(ranked, aliases, { n, by, band, series, otherId, config });
			}
			// No reserved id yet — identity setup reserves it asynchronously — so
			// there is nothing to call Other, and the rows past the cutoff are
			// simply left out, as the JS path does. The query is rebuilt once the id
			// exists.
			return Query.from({ __topn: ranked })
				.select({ ...passthroughSelect(aliases), [RANK_COLUMN]: column(RANK_COLUMN) })
				.where(sqlTag`${column(RANK_COLUMN)} <= ${n}`);
		},
		describe() {
			return `Top ${current()}${options.includeOthers ? ' + Other' : ''} (SQL)`;
		}
	};
}

/**
 * Everything ranked past `n` becomes one Other row per remaining group key.
 *
 * Two steps. BUCKET relabels a row past the cutoff — its band becomes the
 * reserved id and its rank n + 1, so Other sorts after every real category.
 * COLLAPSE groups by the band and every other group key (a series, a facet),
 * so Other gets one row per series:
 *
 * | channel | top row | Other row |
 * |---|---|---|
 * | band, or an id from the band's own dim | itself | the reserved id |
 * | another group key | itself | itself |
 * | the value ranked by | itself | summed |
 * | anything else | itself | 0 |
 * | rank | itself | n + 1 |
 *
 * An id from the band's own dim — colour by category — gets the reserved id so
 * Other is coloured as Other. The JS path gives it 0, which is category 0's
 * colour; that is its bug and not copied here.
 *
 * The reserved id can be a REAL category ("Other" in the data: the reservation
 * reuses it). If that category makes the cut, bucketing gives its row and the
 * excluded rows the same band, and the GROUP BY folds them — summed value, its
 * own values elsewhere, its own rank via MIN. No special case.
 */
function collapseIntoOther(
	ranked: SelectQuery,
	aliases: string[],
	o: {
		n: number;
		by: string;
		band: string;
		series: string | null;
		otherId: number;
		config: MarkConfig | undefined;
	}
): SelectQuery {
	const { n, by, band, otherId } = o;
	const rank = column(RANK_COLUMN);
	const kept = sqlTag`${rank} <= ${n}`;
	const identity = o.config?.identity;
	const bandDim = identity?.[band]?.dim;
	const sameAsBand = (alias: string) =>
		alias === band || (!!bandDim && identity?.[alias]?.dim === bandDim);
	const groupKeys = o.config?.groupKeys ?? (o.series ? [o.series] : []);
	const isKey = (alias: string) => sameAsBand(alias) || groupKeys.includes(alias);

	const bucket: Record<string, ExprNode> = {};
	for (const alias of aliases) {
		const col = column(alias);
		if (sameAsBand(alias)) {
			bucket[alias] = sqlTag`CASE WHEN ${kept} THEN ${col} ELSE ${otherId} END` as ExprNode;
		} else if (isKey(alias) || alias === by) {
			bucket[alias] = col;
		} else {
			bucket[alias] = sqlTag`CASE WHEN ${kept} THEN ${col} END` as ExprNode;
		}
	}
	bucket[RANK_COLUMN] = sqlTag`CASE WHEN ${kept} THEN ${rank} ELSE ${n + 1} END` as ExprNode;
	const bucketed = Query.from({ __topn_ranked: ranked }).select(bucket);

	const collapse: Record<string, ExprNode> = {};
	const keys: ExprNode[] = [];
	for (const alias of aliases) {
		const col = column(alias);
		if (isKey(alias)) {
			collapse[alias] = col;
			keys.push(col);
		} else if (alias === by) {
			collapse[alias] = sqlTag`CAST(SUM(${col}) AS REAL)` as ExprNode;
		} else {
			collapse[alias] = sqlTag`COALESCE(MAX(${col}), 0)` as ExprNode;
		}
	}
	collapse[RANK_COLUMN] = sqlTag`MIN(${rank})` as ExprNode;
	return Query.from({ __topn_bucketed: bucketed })
		.select(collapse)
		.groupby(...keys);
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
			// barx swaps value/band axes, same convention as topN.
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
