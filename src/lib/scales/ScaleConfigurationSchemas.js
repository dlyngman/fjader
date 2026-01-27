/**
 * Resolution strategies for conflicting configuration values
 */
export const RESOLUTION_STRATEGIES = {
	MAX: (values) => Math.max(...values),
	MIN: (values) => Math.min(...values),
	AVERAGE: (values) => values.reduce((sum, val) => sum + val, 0) / values.length,
	BOOLEAN_OR: (values) => values.some((v) => v === true),
	BOOLEAN_AND: (values) => values.every((v) => v === true),
	FIRST_WINS: (values) => values[0],
	MUST_MATCH: (values) => {
		const first = values[0];
		if (values.every((v) => v === first)) return first;
		throw new Error(`Conflicting configuration values: ${values.join(', ')}`);
	}
};

/**
 * Configuration schemas for different scale types
 * Each property defines: type, validation, resolution strategy, and description
 */
export const SCALE_CONFIG_SCHEMAS = {
	band: {
		padding: {
			type: 'number',
			range: [0, 1],
			strategy: RESOLUTION_STRATEGIES.MAX,
			description: 'Overall padding between category groups'
		},
		paddingInner: {
			type: 'number',
			range: [0, 1],
			strategy: RESOLUTION_STRATEGIES.MAX,
			description: 'Space between bars within a group'
		},
		paddingOuter: {
			type: 'number',
			range: [0, 1],
			strategy: RESOLUTION_STRATEGIES.MAX,
			description: 'Space before first and after last group'
		},
		align: {
			type: 'number',
			range: [0, 1],
			strategy: RESOLUTION_STRATEGIES.AVERAGE,
			description: 'Alignment within outer padding (0=left, 0.5=center, 1=right)'
		}
	},

	linear: {
		nice: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR,
			description: 'Extend domain to nice round numbers'
		},
		clamp: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR,
			description: 'Clamp values outside domain'
		},
		zero: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR,
			description: 'Include zero in domain'
		},
		domainMin: {
			type: 'number',
			strategy: RESOLUTION_STRATEGIES.MIN,
			description: 'Explicit minimum domain value'
		},
		domainMax: {
			type: 'number',
			strategy: RESOLUTION_STRATEGIES.MAX,
			description: 'Explicit maximum domain value'
		}
	},

	point: {
		padding: {
			type: 'number',
			range: [0, 1],
			strategy: RESOLUTION_STRATEGIES.MAX,
			description: 'Padding around point scale range'
		},
		align: {
			type: 'number',
			range: [0, 1],
			strategy: RESOLUTION_STRATEGIES.AVERAGE,
			description: 'Alignment within padding'
		}
	}

	// Future scale types can be added here:
	// log: { ... },
	// time: { ... },
	// ordinal: { ... }
};

/**
 * Validate a configuration value against its schema
 * @param {*} value - Value to validate
 * @param {Object} schema - Property schema
 * @returns {boolean} Whether value is valid
 */
export function validateConfigValue(value, schema) {
	// Type validation
	if (schema.type === 'number' && typeof value !== 'number') {
		return false;
	}
	if (schema.type === 'boolean' && typeof value !== 'boolean') {
		return false;
	}
	if (schema.type === 'string' && typeof value !== 'string') {
		return false;
	}

	// Range validation for numbers
	if (schema.range && typeof value === 'number') {
		const [min, max] = schema.range;
		if (value < min || value > max) {
			return false;
		}
	}

	// Could add more validation rules here:
	// - enum validation
	// - custom validators
	// - etc.

	return true;
}
