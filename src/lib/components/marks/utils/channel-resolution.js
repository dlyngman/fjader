/**
 * Channel Resolution Utilities
 *
 * Provides composable data resolution for mark channels, handling:
 * - Transform-generated columns (e.g., stack outputs x0/x1)
 * - Direct array props for static/manual data
 * - Constant numeric props
 * - Database columns from SQL queries (via DataAccessor)
 * - Fallback values
 *
 * @module channel-resolution
 */

/**
 * Resolves a channel prop to raw data array.
 *
 * Resolution priority (CRITICAL - order matters!):
 * 1. Transform Overrides (tryColumns) - e.g., 'x0' from stack transform
 * 2. Direct Array/TypedArray Props - e.g., x={[1,2,3]} for No-DB mode
 * 3. Constant Numeric Props - e.g., x1={0} for baseline
 * 4. Default Data Column (channel) - e.g., 'x1' from SQL query
 * 5. Fallback Value - e.g., alpha defaults to 0.8
 *
 * This utility handles FETCHING only. The caller is responsible for any scale
 * transformations (e.g., converting categorical strings to indices).
 *
 * @param {object} params
 * @param {any} params.value - The channel prop value (e.g., x1 prop = 0, "species" field name, [1,2,3])
 * @param {string} [params.channel] - The default column name to check in DataAccessor (e.g., 'x1', 'y', 'alpha')
 * @param {object} [params.dataAccessor] - DataAccessor instance (ArrowDataAccessor or ObjectDataAccessor)
 * @param {string[]} [params.tryColumns] - OVERRIDE columns to check FIRST (e.g., ['x0'] for stack output).
 *                                         DO NOT include the default channel here - it will shadow constants!
 * @param {number} params.instanceCount - Number of instances (used for expanding constants and validating arrays)
 * @param {number} [params.fallback] - Fallback value if all resolution attempts fail
 * @returns {Float32Array|Array|null} Raw data (could be strings for categorical, numbers for quantitative)
 *
 * @example
 * // Transform override: check 'x0' from stack, then constant, then default 'x1' column
 * const data = resolveChannel({
 *   value: x1,  // = 0 (constant baseline)
 *   channel: 'x1',  // Default column name
 *   tryColumns: hasStackTransform ? ['x0'] : undefined,  // Only override, not default!
 *   dataAccessor: setup.data,
 *   instanceCount: 100,
 *   fallback: 0
 * });
 *
 * @example
 * // Manual array data (No-DB mode)
 * const data = resolveChannel({
 *   value: [10, 20, 30],
 *   instanceCount: 3
 * });
 *
 * @example
 * // Constant prop
 * const data = resolveChannel({
 *   value: 0.8,
 *   channel: 'alpha',
 *   instanceCount: 100,
 *   fallback: 1.0
 * });
 */
export function resolveChannel({
	value,
	channel,
	dataAccessor,
	tryColumns,
	instanceCount,
	fallback
}) {
	if (!instanceCount) return null;

	// 1. Transform Overrides
	// ONLY check specific override columns here (like 'x0' from stack).
	// DO NOT check the default 'channel' here, or it will shadow constants!
	if (dataAccessor && tryColumns) {
		for (const col of tryColumns) {
			const data = dataAccessor.getColumn(col);
			if (data) {
				// Zero-copy for Arrow: returns WASM Float32Array view directly
				return data;
			}
		}
	}

	// 2. Direct Array/TypedArray Prop (Manual/Static Data)
	// Supports both JS arrays ([1, 2, 3]) and TypedArrays (new Float32Array([1, 2, 3]))
	if (Array.isArray(value) || ArrayBuffer.isView(value)) {
		// Dev-mode validation: ensure array length matches instance count
		if (value.length !== instanceCount) {
			throw new Error(
				`Channel array length mismatch: expected ${instanceCount} items, got ${value.length}. ` +
					`Each channel must have the same length as the instance count.`
			);
		}
		return value;
	}

	// 3. Constant Numeric Prop
	// If value is a number (e.g., alpha={0.8}, x1={0}), expand to filled array
	if (typeof value === 'number') {
		const arr = new Float32Array(instanceCount);
		arr.fill(value);
		return arr;
	}

	// 4. Default Data Column
	// If we reach here, value is likely a field string or null
	// Check the default column name in the DataAccessor
	if (dataAccessor && channel) {
		const data = dataAccessor.getColumn(channel);
		if (data) return data;
	}

	// 5. Fallback
	// Used when column doesn't exist and no value provided
	// Example: alpha column missing from data, use fallback 0.8
	if (fallback !== undefined) {
		const arr = new Float32Array(instanceCount);
		arr.fill(fallback);
		return arr;
	}

	return null;
}

/**
 * Converts raw data to Float32Array for GPU rendering.
 *
 * This is a pass-through for data that's already Float32Array (zero-copy),
 * and converts other numeric arrays to Float32Array for WebGPU compatibility.
 *
 * Note: This does NOT handle scale transformations. Use this AFTER resolving
 * scale lookups (e.g., categorical → indices, color fields → palette indices).
 *
 * @param {Array|TypedArray|null} data - Raw numeric data
 * @returns {Float32Array|null}
 *
 * @example
 * const raw = resolveChannel({ value: x, ... });
 * const gpuData = toFloat32(raw); // Safe for WebGPU
 */
export function toFloat32(data) {
	if (!data) return null;
	if (data instanceof Float32Array) return data;
	return new Float32Array(data);
}
