/**
 * Derived-column naming for the time offset channel.
 *
 * This file was the CASE machinery that mapped category values to integer
 * indices for band, facet and ordinal colour. All three now carry identity ids
 * resolved through the shared slot table, so the CASE builder, its SQL literal
 * escaper and the colour index column name are gone with them — see step 3b.
 *
 * The escaper is worth a note on the way out: it wrapped every literal in
 * single quotes via String(value), which DuckDB casts happily for numbers and
 * booleans and rejects outright for DATE and TIMESTAMP. Faceting or colouring
 * by a date column threw a conversion error, and the fix was structural — a dim
 * joins on the native value and never stringifies it.
 */

/** Column alias for time offset. */
export function timeOffsetColumn(field: string): string {
	return `__dplot_${field}_time_offset`;
}
