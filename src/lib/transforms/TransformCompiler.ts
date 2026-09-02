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

	applyToQuery(query: SelectQuery): SelectQuery {
		let result = query;

		for (const transform of this.sqlTransforms) {
			try {
				result = transform.apply(result, this.markConfig);
			} catch (error) {
				throw new Error(
					`Failed to apply ${transform.type} transform: ${(error as Error).message}`,
					{ cause: error }
				);
			}
		}

		return result;
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

	getCategoryTransformKey(): string | null {
		const parts: string[] = [];
		for (const t of this.transforms) {
			if (t.type === 'topN') parts.push(t.describe?.() || t.type);
		}
		return parts.length > 0 ? parts.join('+') : null;
	}
}
