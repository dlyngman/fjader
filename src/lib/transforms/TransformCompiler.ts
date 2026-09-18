import type { SelectQuery } from '@uwdata/mosaic-sql';
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
	applyToQuery(query: SelectQuery, facts?: Partial<MarkConfig>): SelectQuery {
		let result = query;
		const config = this.#configFor(facts);

		for (const transform of this.sqlTransforms) {
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
	 * before the transform can write it (§16.9).
	 */
	hasSyntheticOtherBucket(): boolean {
		return this.transforms.some((t) => t.type === 'topN' && t.spec?.includeOthers === true);
	}

	getCategoryTransformKey(): string | null {
		const parts: string[] = [];
		for (const t of this.transforms) {
			if (t.type === 'topN') parts.push(t.describe?.() || t.type);
		}
		return parts.length > 0 ? parts.join('+') : null;
	}
}
