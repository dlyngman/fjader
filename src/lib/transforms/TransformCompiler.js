// src/lib/transforms/TransformCompiler.js

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

export class TransformCompiler {
	constructor(transforms = []) {
		this.transforms = transforms;

		// Separate by stage
		this.sqlTransforms = transforms.filter((t) => t.stage === 'sql');
		this.jsTransforms = transforms.filter((t) => t.stage === 'js');

		// Validate ordering (SQL must come before JS)
		this.#validateStaging();
	}

	/**
	 * Ensure SQL transforms come before JS transforms
	 */
	#validateStaging() {
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

	/**
	 * Apply SQL transforms to query
	 * @param {Query} query - Mosaic Query object
	 * @returns {Query} Modified query
	 */
	applyToQuery(query) {
		let result = query;

		for (const transform of this.sqlTransforms) {
			try {
				result = transform.apply(result);
			} catch (error) {
				throw new Error(`Failed to apply ${transform.type} transform: ${error.message}`);
			}
		}

		return result;
	}

	/**
	 * Apply JS transforms to data
	 * @param {Array|ArrowTable} data - Data to transform
	 * @param {object} config - Mark configuration (x, y, fill fields)
	 * @param {object} scales - Scale objects for context
	 * @returns {Array} Transformed data
	 */
	applyToData(data, config, scales = {}) {
		let result = Array.isArray(data) ? data : this.#arrowToArray(data);

		for (const transform of this.jsTransforms) {
			try {
				result = transform.apply(result, config, scales);
			} catch (error) {
				throw new Error(`Failed to apply ${transform.type} transform: ${error.message}`);
			}
		}

		return result;
	}

	/**
	 * Convert Arrow table to array of objects
	 */
	#arrowToArray(arrowTable) {
		const rows = [];
		const numRows = arrowTable.numRows;

		for (let i = 0; i < numRows; i++) {
			const row = {};
			for (const field of arrowTable.schema.fields) {
				const column = arrowTable.getChild(field.name);
				row[field.name] = column.get(i);
			}
			rows.push(row);
		}

		return rows;
	}

	/**
	 * Get additional channels that transforms will add
	 * For example, stack() adds y0 and y1
	 * @returns {Array<string>} Channel names
	 */
	getAdditionalChannels() {
		const channels = [];

		for (const transform of this.jsTransforms) {
			if (transform.channels) {
				channels.push(...transform.channels);
			}
		}

		return channels;
	}

	/**
	 * Validate that query is flat (no CTEs, no subqueries)
	 * This is critical for Mosaic's PreAggregator optimization
	 * @param {Query} query
	 * @throws {Error} If query contains CTEs or subqueries
	 */
	validateQuery(query) {
		const sql = query.toString();

		// Check for WITH clause (CTEs)
		if (/\bWITH\s+/i.test(sql)) {
			throw new Error(
				'Transform pipeline generated a CTE (WITH clause). ' +
					"This breaks Mosaic's PreAggregator optimization. " +
					'CTEs prevent the optimizer from recognizing GROUP BY patterns. ' +
					'Problematic transforms: ' +
					this.sqlTransforms.map((t) => t.type).join(', ')
			);
		}

		// Check for subqueries (nested SELECT)
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

	/**
	 * Get human-readable description of the pipeline
	 * Useful for debugging and documentation
	 * @returns {string}
	 */
	describe() {
		const parts = [];

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

	/**
	 * Check if pipeline has any transforms
	 */
	isEmpty() {
		return this.transforms.length === 0;
	}

	/**
	 * Check if pipeline has SQL transforms
	 */
	hasSQLTransforms() {
		return this.sqlTransforms.length > 0;
	}

	/**
	 * Check if pipeline has JS transforms
	 */
	hasJSTransforms() {
		return this.jsTransforms.length > 0;
	}
}
