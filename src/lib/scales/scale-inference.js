// src/lib/scales/scale-inference.js

import { isNode, isAggregateExpression } from '@uwdata/mosaic-sql';

/**
 * Infer the optimal scale type from a field definition, its database schema type,
 * and the context in which the scale will be used.
 *
 * This is the centralized "brain" for scale type decisions. It handles:
 * - SQL expression nodes (aggregates, bins) → always continuous
 * - Raw column names → schema-based inference (date→time, number→linear, string→band)
 * - Context-dependent mapping (axis vs visual vs size channels)
 *
 * @param {Object} opts
 * @param {*} opts.field - Column name (string), SQL expression node, or null
 * @param {string|null} opts.schemaType - Simplified JS type: 'number'|'date'|'string'|'boolean'|null
 * @param {'axis'|'visual'|'size'} opts.context - Where this scale is used:
 *   - 'axis': position channels (x, y) — maps to time/linear/band
 *   - 'visual': appearance channels (color, fill, opacity) — maps to sequential/ordinal
 *   - 'size': size channels (radius, strokeWidth) — maps to sqrt/linear/ordinal
 * @returns {string|null} Scale type string, or null if schema is needed but unavailable (caller should block)
 */
export function inferScaleType({ field, schemaType, context }) {
	// SQL expression nodes: infer from expression semantics, not schema
	if (isNode(field)) {
		if (isAggregateExpression(field)) {
			if (context === 'axis') return 'linear';
			if (context === 'visual') return 'sequential';
			return 'sqrt'; // size context
		}
		if (field.isAutoBinNode || field.type === 'Bin') {
			if (context === 'axis') return 'linear';
			return 'sequential'; // visual or size
		}
		// Other SQL nodes (column refs, functions): can't look up in schema
		// Return null so caller provides its own fallback
		return null;
	}

	// Raw column name — needs schema to infer
	if (typeof field === 'string') {
		if (!schemaType) {
			// Schema not available yet — signal caller to block
			return null;
		}

		if (schemaType === 'date') {
			if (context === 'axis') return 'time';
			if (context === 'visual') return 'sequential';
			return 'linear'; // size context
		}

		if (schemaType === 'number') {
			if (context === 'axis') return 'linear';
			if (context === 'visual') return 'sequential';
			return 'sqrt'; // size: perceptual scaling
		}

		if (schemaType === 'string' || schemaType === 'boolean') {
			if (context === 'axis') return 'band';
			return 'ordinal'; // visual or size
		}
	}

	// Fallback for unknown field types (arrays, typed arrays, etc.)
	if (context === 'axis') return 'linear';
	if (context === 'visual') return 'ordinal';
	return 'linear'; // size fallback
}
