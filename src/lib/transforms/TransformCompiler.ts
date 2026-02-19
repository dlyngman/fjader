import type { SelectQuery } from '@uwdata/mosaic-sql';
import type { Transform, SqlTransform, JsTransform, MarkConfig, ScaleMap } from '$lib/types';

/**
 * TransformCompiler orchestrates the transform pipeline.
 *
 * Responsibilities:
 * - Separate SQL and JS transforms
 * - Apply SQL transforms to Query AST
 * - Validate queries remain flat (no CTEs)
 * - Apply JS transforms to Arrow data
 * - Extract additional channels (y0/y1, x0/x1)
 */

interface ArrowTable {
	numRows: number;
	schema: { fields: { name: string }[] };
	getChild(name: string): { get(index: number): unknown } | null;
}

export class TransformCompiler {
	transforms: Transform[];
	sqlTransforms: SqlTransform[];
	jsTransforms: JsTransform[];

	constructor(transforms: Transform[] = []) {
		this.transforms = transforms;

		// Separate by stage
		this.sqlTransforms = transforms.filter((t): t is SqlTransform => t.stage === 'sql');
		this.jsTransforms = transforms.filter((t): t is JsTransform => t.stage === 'js');

		// Validate ordering (SQL must come before JS)
		this.#validateStaging();
	}

	#validateStaging(): void {
		let seenJS = false;

		for (const transform of this.transforms) {
			if (transform.stage === 'js') {
				seenJS = true;
			} else if (transform.stage === 'sql' && seenJS) {
				throw new Error(
					`Invalid transform order: SQL transform "${transform.type}" appears after JS transform. ` +
						`SQL transforms must come before JS transforms in the pipeline.`
				);
			}
		}
	}

	applyToQuery(query: SelectQuery): SelectQuery {
		let result = query;

		for (const transform of this.sqlTransforms) {
			try {
				result = transform.apply(result);
			} catch (error) {
				throw new Error(
					`Failed to apply ${transform.type} transform: ${(error as Error).message}`
				);
			}
		}

		return result;
	}

	applyToData(
		data: Record<string, unknown>[] | ArrowTable,
		config: MarkConfig,
		scales: ScaleMap = {}
	): Record<string, unknown>[] {
		let result = Array.isArray(data) ? data : this.#arrowToArray(data);

		for (const transform of this.jsTransforms) {
			try {
				result = transform.apply(result, config, scales);
			} catch (error) {
				throw new Error(
					`Failed to apply ${transform.type} transform: ${(error as Error).message}`
				);
			}
		}

		return result;
	}

	#arrowToArray(arrowTable: ArrowTable): Record<string, unknown>[] {
		const rows: Record<string, unknown>[] = [];
		const numRows = arrowTable.numRows;

		for (let i = 0; i < numRows; i++) {
			const row: Record<string, unknown> = {};
			for (const field of arrowTable.schema.fields) {
				const column = arrowTable.getChild(field.name);
				row[field.name] = column?.get(i);
			}
			rows.push(row);
		}

		return rows;
	}

	getAdditionalChannels(): string[] {
		const channels: string[] = [];

		for (const transform of this.jsTransforms) {
			if (transform.channels) {
				channels.push(...transform.channels);
			}
		}

		return channels;
	}

	validateQuery(query: SelectQuery): void {
		const sql = query.toString();

		if (/\bWITH\s+/i.test(sql)) {
			throw new Error(
				'Transform pipeline generated a CTE (WITH clause). ' +
					"This breaks Mosaic's PreAggregator optimization. " +
					'CTEs prevent the optimizer from recognizing GROUP BY patterns. ' +
					'Problematic transforms: ' +
					this.sqlTransforms.map((t) => t.type).join(', ')
			);
		}

		if (/\(\s*SELECT\s+/i.test(sql)) {
			throw new Error(
				'Transform pipeline generated a subquery. ' +
					"This breaks Mosaic's PreAggregator optimization. " +
					'Subqueries prevent the optimizer from building materialized cubes. ' +
					'Problematic transforms: ' +
					this.sqlTransforms.map((t) => t.type).join(', ')
			);
		}
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
}
