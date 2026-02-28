import { inferScaleType } from '$lib/scales/scale-inference';
import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';
import type { FieldRef } from '$lib/types';

export function inferMarkScaleType(
	field: FieldRef | null,
	table: string,
	preferredType: string | null
): string | null {
	if (preferredType != null) return preferredType;
	if (!field) return 'linear';

	// AutoBinNode: unwrap to get underlying column for schema lookup
	if (typeof field !== 'string' && 'isAutoBinNode' in field && field.isAutoBinNode) {
		const colName =
			'field' in field && typeof field.field === 'string' ? field.field : null;
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
