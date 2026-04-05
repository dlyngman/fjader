/**
 * SQL CASE expression utilities for categorical-to-integer indexing.
 *
 * Used by BandScaleState, ColorScaleState to build inline CASE expressions
 * that map categories to integer indices in the query SELECT.
 */

const CARDINALITY_WARNING = 500;

function escapeSql(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build a SQL CASE expression that maps domain values to integer indices.
 * Output is CAST to REAL for Float32Array zero-copy.
 *
 * @param oneBased - If true, indices start at 1 (0 = default). If false, start at 0 (-1 = default).
 */
export function buildCaseExpression(
	sourceColumn: string,
	domain: unknown[],
	{ oneBased = false } = {}
): string {
	if (!domain || domain.length === 0) {
		return oneBased ? 'CAST(0 AS REAL)' : 'CAST(-1 AS REAL)';
	}

	if (domain.length > CARDINALITY_WARNING) {
		console.warn(
			`[buildCaseExpression] High cardinality: ${domain.length} categories for ${sourceColumn}.`
		);
	}

	const offset = oneBased ? 1 : 0;
	const defaultValue = oneBased ? 0 : -1;

	const whenClauses = domain
		.map((value, index) => `WHEN "${sourceColumn}" = ${escapeSql(value)} THEN ${index + offset}`)
		.join(' ');

	return `CAST(CASE ${whenClauses} ELSE ${defaultValue} END AS REAL)`;
}

/** Column alias for band scale index. */
export function bandIndexColumn(field: string): string {
	return `__dplot_${field}_idx`;
}

/** Column alias for color scale index. */
export function colorIndexColumn(field: string): string {
	return `__dplot_${field}_color_idx`;
}

/** Column alias for time offset. */
export function timeOffsetColumn(field: string): string {
	return `__dplot_${field}_time_offset`;
}
