// src/lib/components/marks/utils/inferMarkScaleType.js

import { inferScaleType } from '$lib/scales/scale-inference';
import { tableSchemaService } from '$lib/data/TableSchemaService.svelte.js';

/**
 * Infer the scale type for a mark's axis channel, handling all field types:
 * - Preferred type override (user-specified)
 * - AutoBinNode: unwrap to underlying column for schema-based inference
 * - String column name: schema-based inference
 * - Other (expression nodes, arrays, etc.): default to 'linear'
 *
 * Returns null when schema is not yet available (caller should block/retry).
 *
 * @param {*} field - Channel value: string column name, AutoBinNode, expression, or null
 * @param {string} table - Table name for schema lookup
 * @param {string|null} preferredType - User-specified scale type override
 * @returns {string|null} Scale type or null if schema pending
 */
export function inferMarkScaleType(field, table, preferredType) {
	if (preferredType != null) return preferredType;
	if (!field) return 'linear';

	// AutoBinNode: unwrap to get underlying column for schema lookup
	if (field.isAutoBinNode) {
		const colName = typeof field.field === 'string' ? field.field : null;
		if (!colName) return 'linear';
		const _v = tableSchemaService.version;
		const colType = tableSchemaService.getColumnType(table, colName);
		if (!colType) {
			tableSchemaService.getSchema(table);
			return null;
		}
		return inferScaleType({ field: colName, schemaType: colType, context: 'axis' });
	}

	// Non-string, non-bin (expression nodes, arrays, typed arrays)
	if (typeof field !== 'string') return 'linear';

	// String column name: schema-based inference
	const _v = tableSchemaService.version;
	const colType = tableSchemaService.getColumnType(table, field);
	if (!colType) {
		tableSchemaService.getSchema(table);
		return null;
	}
	return inferScaleType({ field, schemaType: colType, context: 'axis' });
}
