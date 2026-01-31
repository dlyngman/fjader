// src/lib/sql/bin.js

import { binDate, binHistogram, column, sql } from '@uwdata/mosaic-sql';

/**
 * Bin numeric or temporal data into discrete intervals.
 *
 * Always returns an AutoBinNode that defers SQL generation until field
 * statistics (min/max) are available. This follows the vgplot pattern where
 * all binning goes through Mosaic's binHistogram/binDate helpers, ensuring
 * correct nice rounding, step calculation, and offset handling.
 *
 * @param {string|Expression} field - Field to bin
 * @param {object} options - Configuration
 * @param {number} options.step - Explicit bin size (numeric)
 * @param {string} options.interval - Explicit interval (temporal: day, week, month, year)
 * @param {number} options.steps - Target number of bins (hint, default ~25)
 * @param {number} options.minstep - Minimum bin size
 * @param {boolean} options.nice - Use nice round numbers (default true)
 * @param {number} options.offset - Bin offset in steps (used by extent expansion)
 * @returns {AutoBinNode}
 */
export function bin(field, options = {}) {
	return new AutoBinNode(field, options);
}

/**
 * Deferred bin node that generates SQL once field statistics are available.
 * Modeled after vgplot's BinTransformNode — always delegates to Mosaic's
 * binHistogram() or binDate() for correct bin boundary computation.
 */
export class AutoBinNode {
	constructor(field, options = {}) {
		this.field = field;
		this.options = options;
		this.isAutoBinNode = true; // Marker for detection
	}

	/**
	 * Get field statistics needed for this bin.
	 * Called by BaseMarkSetup to build field info requests.
	 */
	get stats() {
		const fieldName = typeof this.field === 'string' ? this.field : this.field.toString();
		return {
			column: fieldName,
			stats: ['min', 'max']
		};
	}

	/**
	 * Resolve to concrete SQL expression once field statistics are available.
	 * Always delegates to Mosaic's binHistogram or binDate, which handle:
	 * - Nice rounding of bin boundaries
	 * - Step calculation from desired bin count
	 * - Correct offset handling (shifts inside floor() for extent marks)
	 *
	 * @param {object} fieldInfo - Field statistics from DataClient
	 * @param {string} scaleType - Scale type (linear, time, etc.)
	 * @param {number|null} timeOffset - Global t0 (ms) for time offset optimization
	 * @returns {Expression} Mosaic SQL expression
	 */
	resolve(fieldInfo, scaleType, timeOffset = null) {
		const fieldName = typeof this.field === 'string' ? this.field : this.field.toString();
		const info = fieldInfo[fieldName] || {};
		const { min, max, type } = info;

		if (min === undefined || max === undefined) {
			throw new Error(
				`Cannot auto-bin field "${fieldName}": missing min/max statistics. ` +
					`This may happen if the field contains only NULL values or doesn't exist in the table.`
			);
		}

		const col = typeof this.field === 'string' ? column(this.field) : this.field;

		// Detect if temporal
		const isTemporal =
			this.options.interval !== undefined ||
			type === 'date' ||
			scaleType === 'time' ||
			scaleType === 'utc';

		// 1. Generate the standard binning expression (TIMESTAMP or NUMBER)
		const binExpr = isTemporal
			? binDate(col, [min, max], this.options)
			: binHistogram(col, [min, max], this.options);

		// 2. Apply Time Offset Injection
		// If this is a time scale and we have a valid t0, shift the reference frame
		// BEFORE leaving the database to preserve float32 precision.
		if (isTemporal && timeOffset != null) {
			// DuckDB Logic:
			// 1. epoch(binExpr) -> Converts TIMESTAMP to BIGINT (seconds since 1970)
			// 2. - timeOffset    -> Subtracts global start time (t0 in epoch seconds)
			// 3. CAST(... AS REAL) -> Converts to Float32 for GPU
			return sql`CAST((epoch(${binExpr}) - ${timeOffset}) AS REAL)`;
		}

		return binExpr;
	}

	/**
	 * Create a copy with a bin offset (in step units).
	 * Used by expandBinForExtent to produce the upper bound of each bin:
	 * offset=1 shifts by one bin width via binHistogram's offset parameter.
	 *
	 * @param {number} offset - Bin offset in steps
	 * @returns {AutoBinNode}
	 */
	withOffset(offset) {
		return new AutoBinNode(this.field, {
			...this.options,
			offset
		});
	}
}

/**
 * Check if an expression is a bin node.
 * @param {*} expr
 * @returns {boolean}
 */
export function isBinExpression(expr) {
	if (!expr) return false;
	return expr.isAutoBinNode === true;
}

/**
 * Expand a bin expression to extent channels (x1/x2 or y1/y2) for rect/rule marks.
 * For extent marks, creates two bin nodes: one at offset 0 (bin start) and one
 * at offset 1 (bin end), following the vgplot pattern.
 *
 * @param {AutoBinNode|*} binExpr - Bin expression or other channel value
 * @param {string} channel - 'x' or 'y'
 * @param {string} markType - 'rect', 'rectX', 'rectY', etc.
 * @returns {object} Map of channel names to expressions
 */
export function expandBinForExtent(binExpr, channel, markType) {
	if (!isBinExpression(binExpr)) {
		return { [channel]: binExpr };
	}

	const needsExtent = ['rect', 'rectX', 'rectY', 'rule', 'ruleX', 'ruleY'].includes(markType);

	if (!needsExtent) {
		return { [channel]: binExpr };
	}

	return {
		[`${channel}1`]: binExpr,
		[`${channel}2`]: binExpr.withOffset(1)
	};
}
