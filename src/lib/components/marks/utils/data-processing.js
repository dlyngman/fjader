/**
 * Determine the data source type for processing strategy
 * @param {*} value - The value to classify
 * @returns {string} Type: 'constant', 'array', 'float32array', or 'sql'
 */
export function getSourceType(value) {
	if (typeof value === 'number') return 'constant';
	if (typeof value === 'string' && isColorString(value)) return 'constant-color';
	if (Array.isArray(value)) return 'array';
	if (value instanceof Float32Array) return 'float32array';
	return 'sql'; // Everything else goes to database
}

/**
 * Data processors for converting various sources to GPU-ready Float32Arrays
 */
const processors = {
	constant: (value, instanceCount) => new Float32Array(instanceCount).fill(value),
	array: (value) => new Float32Array(value),
	float32array: (value) => value, // Pass through - already optimized
	sql: (column) => {
		if (!column) return null;
		const rawArray = column.toArray();
		return rawArray instanceof Float32Array ? rawArray : new Float32Array(rawArray);
	}
};

/**
 * Process data with optional pre-computed strategy
 */
export function processData(value, column, instanceCount, strategy = null) {
	const type = strategy || getSourceType(value);
	if (!type) return null;

	if (type === 'constant') return processors.constant(value, instanceCount);
	if (type === 'sql') return processors.sql(column);
	return processors[type](value);
}

/**
 * Process alpha data with strategy
 */
export function processAlphaData(alpha, instanceCount, strategy = null) {
	if (!instanceCount) return null;

	const type = strategy || getSourceType(alpha);

	switch (type) {
		case 'constant':
			const alphas = new Float32Array(instanceCount);
			alphas.fill(alpha);
			return alphas;

		case 'sql':
			// Future: support alpha from database column
			return null;

		default:
			const defaultAlphas = new Float32Array(instanceCount);
			defaultAlphas.fill(0.8);
			return defaultAlphas;
	}
}

/**
 * Helper for building select object with only SQL expressions that need database queries
 * @param {Object} channels - Object with channel names and values
 * @returns {Object} Select object for DataClient
 */
export function buildSelectFromChannels(channels) {
	const select = {};

	for (const [key, value] of Object.entries(channels)) {
		if (value !== undefined && getSourceType(value) === 'sql') {
			select[key] = value;
		}
	}

	return select;
}

/**
 * Check if a string represents a color value
 */
function isColorString(value) {
	return value.startsWith('#') || CSS_COLOR_NAMES.has(value.toLowerCase());
}

/**
 * Parse color string to RGBA array
 */
export function parseColor(color) {
	if (typeof color === 'string') {
		if (color.startsWith('#')) {
			// Hex color handling
			const hex = color.slice(1);
			if (hex.length === 3) {
				const r = parseInt(hex[0] + hex[0], 16) / 255;
				const g = parseInt(hex[1] + hex[1], 16) / 255;
				const b = parseInt(hex[2] + hex[2], 16) / 255;
				return [r, g, b, 1.0];
			} else if (hex.length === 6) {
				const r = parseInt(hex.slice(0, 2), 16) / 255;
				const g = parseInt(hex.slice(2, 4), 16) / 255;
				const b = parseInt(hex.slice(4, 6), 16) / 255;
				return [r, g, b, 1.0];
			}
		} else {
			// CSS color names
			const rgb = CSS_COLOR_NAMES.get(color.toLowerCase());
			if (rgb) return [...rgb, 1.0];
		}
	}
	return [0.2, 0.4, 0.8, 1.0]; // Default blue
}

/**
 * Process color data from various sources into GPU-ready RGBA Float32Array
 */
export function processColorData(value, column, instanceCount, colorScale = null, strategy = null) {
	if (!instanceCount) return null;

	const sourceType = strategy || getSourceType(value);
	const rgba = new Float32Array(instanceCount * 4);

	switch (sourceType) {
		case 'constant-color':
			// Constant color for all instances
			const parsed = parseColor(value);
			for (let i = 0; i < instanceCount; i++) {
				rgba.set(parsed, i * 4);
			}
			return rgba;

		case 'sql':
			// Column data with color scale
			if (!column || !colorScale) {
				return getDefaultColorData(instanceCount);
			}

			const colorArray = column.toArray();
			for (let i = 0; i < instanceCount; i++) {
				const colorValue = colorArray[i];
				const fillColor = colorScale(colorValue);
				const parsed = parseColor(fillColor);
				rgba.set(parsed, i * 4);
			}
			return rgba;

		default:
			return getDefaultColorData(instanceCount);
	}
}

function getDefaultColorData(instanceCount) {
	const rgba = new Float32Array(instanceCount * 4);
	const defaultColor = [0.2, 0.4, 0.8, 1.0];
	for (let i = 0; i < instanceCount; i++) {
		rgba.set(defaultColor, i * 4);
	}
	return rgba;
}

// CSS color names mapping
const CSS_COLOR_NAMES = new Map([
	['red', [1, 0, 0]],
	['green', [0, 0.5, 0]],
	['blue', [0, 0, 1]],
	['orange', [1, 0.65, 0]],
	['purple', [0.5, 0, 0.5]],
	['yellow', [1, 1, 0]],
	['pink', [1, 0.75, 0.8]],
	['brown', [0.65, 0.16, 0.16]],
	['gray', [0.5, 0.5, 0.5]],
	['grey', [0.5, 0.5, 0.5]],
	['black', [0, 0, 0]],
	['white', [1, 1, 1]]
	// Add more as needed
]);
