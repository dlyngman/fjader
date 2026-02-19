import { isNode, isAggregateExpression } from '@uwdata/mosaic-sql';

export type InferenceContext = 'axis' | 'visual' | 'size';

interface InferScaleTypeOptions {
	field: unknown;
	schemaType: string | null;
	context: InferenceContext;
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
	context
}: InferScaleTypeOptions): string | null {
	// SQL expression nodes: infer from expression semantics, not schema
	if (isNode(field)) {
		if (isAggregateExpression(field)) {
			if (context === 'axis') return 'linear';
			if (context === 'visual') return 'sequential';
			return 'sqrt'; // size context
		}
		const node = field as unknown as Record<string, unknown>;
		if (node.isAutoBinNode || node.type === 'Bin') {
			if (context === 'axis') return 'linear';
			return 'sequential'; // visual or size
		}
		// Other SQL nodes (column refs, functions): can't look up in schema
		return null;
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
