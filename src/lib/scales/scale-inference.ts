import { isNode, isAggregateExpression } from '@uwdata/mosaic-sql';
import { isBinExpression } from '$lib/sql/bin';

export type InferenceContext = 'axis' | 'visual' | 'size';

interface InferScaleTypeOptions {
	field: unknown;
	schemaType: string | null;
	context: InferenceContext;
	/** Fallback for SQL nodes that aren't aggregates or bins (e.g., SIGN(...), arithmetic).
	 *  Defaults to null (unknown). Pass 'sequential' when a definite answer is needed. */
	nodeFallback?: string | null;
}

/**
 * Infer the optimal scale type from a field definition, its database schema type,
 * and the context in which the scale will be used.
 *
 * This is the centralized "brain" for scale type decisions. It handles:
 * - SQL expression nodes (aggregates, bins) → always continuous
 * - Raw column names → schema-based inference (date→time, number→linear, string→band)
 * - Context-dependent mapping (axis vs visual vs size channels)
 */
export function inferScaleType({
	field,
	schemaType,
	context,
	nodeFallback = null
}: InferScaleTypeOptions): string | null {
	// SQL expression nodes: infer from expression semantics, not schema
	if (isNode(field)) {
		if (isAggregateExpression(field)) {
			if (context === 'axis') return 'linear';
			if (context === 'visual') return 'sequential';
			return 'sqrt'; // size context
		}
		if (
			isBinExpression(field) ||
			('type' in (field as object) && (field as { type: string }).type === 'Bin')
		) {
			if (context === 'axis') return 'linear';
			return 'sequential'; // visual or size
		}
		// Other SQL nodes (column refs, functions): can't look up in schema
		return nodeFallback;
	}

	// Raw column name — needs schema to infer
	if (typeof field === 'string') {
		if (!schemaType) {
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

	// Fallback for unknown field types
	if (context === 'axis') return 'linear';
	if (context === 'visual') return 'ordinal';
	return 'linear'; // size fallback
}
