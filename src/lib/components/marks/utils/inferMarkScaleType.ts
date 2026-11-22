import { inferScaleType } from '$lib/scales/scale-inference';
import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';
import type { FieldRef } from '$lib/types';

/**
 * The scale type a mark's channel asks for, from its column's type in the
 * table schema. Null only while that schema loads: once it has loaded (or its
 * fetch failed), a column it doesn't hold — a typo, another letter case, one a
 * transform adds — is linear, so the query runs and says what is wrong rather
 * than the mark waiting forever. A constant, an expression or an array has no
 * column to read: linear.
 */
export function inferMarkScaleType(
	field: FieldRef | number | boolean | null | undefined,
	table: string,
	preferredType: string | null
): string | null {
	if (preferredType != null) return preferredType;
	if (field == null || typeof field === 'number' || typeof field === 'boolean') return 'linear';

	// AutoBinNode: unwrap to get underlying column for schema lookup
	if (typeof field !== 'string' && 'isAutoBinNode' in field && field.isAutoBinNode) {
		const colName = 'field' in field && typeof field.field === 'string' ? field.field : null;
		return colName ? columnScaleType(table, colName) : 'linear';
	}

	// Non-string, non-bin (expression nodes, arrays, typed arrays)
	if (typeof field !== 'string') return 'linear';

	return columnScaleType(table, field);
}

/** A column's scale type from the schema; null while the schema loads. */
function columnScaleType(table: string, column: string): string | null {
	const _v = tableSchemaService.version;
	const colType = tableSchemaService.getColumnType(table, column);
	if (colType) return inferScaleType({ field: column, schemaType: colType, context: 'axis' });
	if (tableSchemaService.isReady(table)) return 'linear';
	tableSchemaService.getSchema(table);
	return null;
}
