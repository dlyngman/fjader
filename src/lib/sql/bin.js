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
	 * @param {[number, number]|null} currentDomain - Current viewport domain for adaptive binning
	 * @returns {Expression} Mosaic SQL expression
	 */
	resolve(fieldInfo, scaleType, timeOffset = null, currentDomain = null, binStepMultiplier = 1.0) {
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

		// Adaptive binning: scale step count based on viewport
		let binOptions = { ...this.options };
		if (currentDomain && binOptions.steps && !binOptions.step && !binOptions.interval) {
			const viewportWidth = currentDomain[1] - currentDomain[0];
			const globalWidth = isTemporal
				? (new Date(max).getTime() - new Date(min).getTime()) / 1000 // seconds
				: max - min;

			if (viewportWidth > 0 && globalWidth > 0) {
				const viewportFraction = viewportWidth / globalWidth;
				const scaledSteps = Math.max(1, Math.round(binOptions.steps / viewportFraction));
				binOptions = { ...binOptions, steps: scaledSteps };
			}
		}

		// Apply user bin multiplier (Shift+Scroll)
		if (binStepMultiplier !== 1.0) {
			if (binOptions.steps) {
				// Higher multiplier = More bins
				binOptions.steps = Math.max(1, Math.round(binOptions.steps * binStepMultiplier));
			}
			if (binOptions.step) {
				// Higher multiplier = Smaller bin width
				binOptions.step = binOptions.step / binStepMultiplier;
			}
			// Note: We ignore 'interval' (strings like 'month') as strictly multiplying them is ambiguous
		}

		// Generate the standard binning expression (TIMESTAMP or NUMBER).
		// Temporal bins return DATE/TIMESTAMP; offset conversion to GPU floats
		// is handled centrally by BaseMarkSetup's time-scale swap section.
		return isTemporal
			? binDate(col, [min, max], binOptions)
			: binHistogram(col, [min, max], binOptions);
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
