import type { ExprNode, SelectQuery } from '@uwdata/mosaic-sql';
import type { Transform, SqlTransform, JsTransform, MarkConfig, ScaleMap } from '$lib/types';
import type { DataAccessor } from '$lib/data/DataAccessor';

export class TransformCompiler {
	transforms: Transform[];
	sqlTransforms: SqlTransform[];
	jsTransforms: JsTransform[];
	/**
	 * Mark context forwarded to SQL transforms at query assembly time.
	 * The same object the mark lifecycle passes to applyToData(); SQL
	 * transforms need it for the same reason JS ones do (barx axis swap,
	 * y → y2 alias resolution for extent-based marks).
	 */
	markConfig: MarkConfig | undefined;

	constructor(transforms: Transform[] = [], markConfig?: MarkConfig) {
		this.transforms = transforms;
		this.markConfig = markConfig;

		// Separate by stage
		this.sqlTransforms = transforms.filter((t): t is SqlTransform => t.stage === 'sql');
		this.jsTransforms = transforms.filter((t): t is JsTransform => t.stage === 'js');

		// Validate ordering (SQL must come before JS)
		this.#validateStaging();
	}

	#validateStaging(): void {
		let precedingJS: string | null = null;

		for (const transform of this.transforms) {
			if (transform.stage === 'js') {
				precedingJS = transform.type;
			} else if (transform.stage === 'sql' && precedingJS) {
				throw new Error(
					`Invalid transform order: SQL transform "${transform.type}" appears after JS transform ` +
						`"${precedingJS}". Move ${transform.type}() before ${precedingJS}() in the transforms array.`
				);
			}
		}
	}

	/**
	 * Apply the SQL transforms. `facts` are what is true of THIS query rather
	 * than of the mark — its GROUP BY keys, say — merged over the mark config for
	 * this call only, so the shared config object is never written per query.
	 */
	applyToQuery(
		query: SelectQuery,
		facts?: Partial<MarkConfig>,
		/** The row filters are already in the table the query reads (a preagg table). */
		options?: { skipRowFilters?: boolean }
	): SelectQuery {
		let result = query;
		const config = this.#configFor(facts);

		for (const transform of this.sqlTransforms) {
			if (options?.skipRowFilters && transform.where !== undefined) continue;
			try {
				result = transform.apply(result, config);
			} catch (error) {
				throw new Error(
					`Failed to apply ${transform.type} transform: ${(error as Error).message}`,
					{ cause: error }
				);
			}
		}

		return result;
	}

	/**
	 * Whether a SQL transform filters on the groups' aggregates (`having`). Its
	 * condition names aggregates over the source rows, which a pre-aggregated table
	 * would recompute over its own groups: `count(*)` counts the table's groups, not
	 * the rows, so it gives a different answer with no error.
	 *
	 * Only the user-facing `having()` does this. The built-ins (topN, rank, stack,
	 * normalize, dense) add no HAVING: each wraps the grouped query in a subquery
	 * (`Query.from({ __topn_base: query })`) and adds window functions or joins, and
	 * those work the same on a preagg table's aggregated result, which is why a topN
	 * mark is served from preagg. The only CTE is assembleQuery's window wrapper for
	 * window aggregates, applied after the transforms. A test in transforms.test.ts
	 * fails if a built-in starts to emit a HAVING; this then has to know it.
	 *
	 * Supporting `having()` on a preagg table would mean rewriting its condition the
	 * way a select channel is rewritten (sufficient-statistics: collectAggregates,
	 * sufficientStats, rewrite; an aggregate not in the select adds a partial
	 * column) and applying it to the inner grouped query BEFORE the transforms wrap
	 * it, so it ends up inside their subquery as it does on the base table.
	 */
	hasHaving(): boolean {
		return this.sqlTransforms.some((t) => t.type === 'having');
	}

	/**
	 * The row predicates of the SQL transforms (`filter`), for a pre-aggregated
	 * table to be built with: its read cannot apply them (see SqlTransform.where).
	 * A row filter applies before grouping, so building the table with it gives the
	 * same rows the base query sees; only `filter()` is one (see hasHaving for the
	 * transforms that are not).
	 */
	rowFilters(): ExprNode[] {
		return this.sqlTransforms.flatMap((t) => (t.where === undefined ? [] : [t.where as ExprNode]));
	}

	/**
	 * Which channels a query with these aliases comes back aligned on, leading
	 * term first, or null. Asked with the same facts as `applyToQuery`, so the
	 * answer is about the query those transforms actually produce.
	 *
	 * NOT quite the same aliases, and the difference is worth knowing. Callers
	 * pass `Object.keys(selectDef)`, while inside `apply` a transform reads the
	 * query it is handed — which by then carries what earlier transforms added:
	 * topN's rank, stack's y0/y1. So the plan is one derivation asked over two
	 * alias sets.
	 *
	 * Benign today because the extra aliases appear in neither `identity` nor
	 * `groupKeys`, which is all `dense()` consults. A transform that added a
	 * channel carrying category ids would break the tie, and then these two have
	 * to be given the same list.
	 */
	alignment(aliases: string[], facts?: Partial<MarkConfig>): string[] | null {
		const config = this.#configFor(facts);
		for (const transform of this.sqlTransforms) {
			const order = transform.alignment?.(aliases, config);
			if (order) return order;
		}
		return null;
	}

	/**
	 * Every SQL transform's parameters as they are now.
	 *
	 * Read from a reactive context, this tracks any parameter given as a getter —
	 * `topN(() => count)` — so the caller can re-query when one changes. The query
	 * itself needs nothing more: transforms read their parameters when applied.
	 */
	get specs(): (Record<string, unknown> | undefined)[] {
		return this.sqlTransforms.map((transform) => transform.spec);
	}

	#configFor(facts: Partial<MarkConfig> | undefined): MarkConfig | undefined {
		return facts ? ({ ...this.markConfig, ...facts } as MarkConfig) : this.markConfig;
	}

	applyToData(data: DataAccessor, config: MarkConfig, scales: ScaleMap = {}): DataAccessor {
		let result = data;

		for (const transform of this.jsTransforms) {
			try {
				result = transform.apply(result, config, scales);
			} catch (error) {
				throw new Error(
					`Failed to apply ${transform.type} transform: ${(error as Error).message}`,
					{ cause: error }
				);
			}
		}

		return result;
	}

	/** Channels a transform adds beyond the base select (e.g. stack's y0/y1) — SQL or JS stage. */
	getAdditionalChannels(): string[] {
		const channels: string[] = [];

		for (const transform of this.transforms) {
			if (transform.channels) {
				channels.push(...transform.channels);
			}
		}

		return channels;
	}

	hasStackTransform(): boolean {
		return this.transforms.some((t) => t.type === 'stack');
	}

	describe(): string {
		const parts: string[] = [];

		if (this.sqlTransforms.length > 0) {
			parts.push('SQL Pipeline:');
			for (const t of this.sqlTransforms) {
				parts.push(`  - ${t.describe?.() || t.type}`);
			}
		}

		if (this.jsTransforms.length > 0) {
			parts.push('JS Pipeline:');
			for (const t of this.jsTransforms) {
				parts.push(`  - ${t.describe?.() || t.type}`);
			}
		}

		return parts.join('\n');
	}

	isEmpty(): boolean {
		return this.transforms.length === 0;
	}

	hasSQLTransforms(): boolean {
		return this.sqlTransforms.length > 0;
	}

	hasJSTransforms(): boolean {
		return this.jsTransforms.length > 0;
	}

	hasCategoryReducingTransforms(): boolean {
		return this.transforms.some((t) => t.type === 'topN');
	}

	/**
	 * Whether any category-reducing transform emits a synthetic "Other" row.
	 * That row exists in no table, so its band id has to be reserved at setup
	 * before the transform can write it.
	 */
	hasSyntheticOtherBucket(): boolean {
		return this.transforms.some((t) => t.type === 'topN' && t.spec?.includeOthers === true);
	}

	/** The `by` a topN Other bucket ranks by when stated explicitly, else null (its default). */
	otherBy(): string | null {
		const t = this.transforms.find((t) => t.type === 'topN' && t.spec?.includeOthers === true);
		const by = (t?.spec as { by?: unknown } | undefined)?.by;
		return typeof by === 'string' ? by : null;
	}

	getCategoryTransformKey(): string | null {
		const parts: string[] = [];
		for (const t of this.transforms) {
			if (t.type === 'topN') parts.push(t.describe?.() || t.type);
		}
		return parts.length > 0 ? parts.join('+') : null;
	}
}
