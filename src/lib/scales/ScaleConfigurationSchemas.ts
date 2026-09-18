export interface PropertySchema {
	type: 'number' | 'boolean' | 'string';
	range?: [number, number];
	strategy: (values: unknown[]) => unknown;
	description: string;
}

export type ScaleConfigSchema = Record<string, PropertySchema>;

/**
 * Resolution strategies for conflicting configuration values
 */
export const RESOLUTION_STRATEGIES = {
	MAX: (values: number[]) => Math.max(...values),
	MIN: (values: number[]) => Math.min(...values),
	AVERAGE: (values: number[]) => values.reduce((sum, val) => sum + val, 0) / values.length,
	BOOLEAN_OR: (values: boolean[]) => values.some((v) => v === true),
	BOOLEAN_AND: (values: boolean[]) => values.every((v) => v === true),
	FIRST_WINS: (values: unknown[]) => values[0],
	MUST_MATCH: (values: unknown[]) => {
		const first = values[0];
		if (values.every((v) => v === first)) return first;
		throw new Error(`Conflicting configuration values: ${values.join(', ')}`);
	}
};

/**
 * Configuration schemas for different scale types.
 * Each property defines: type, validation, resolution strategy, and description.
 */
export const SCALE_CONFIG_SCHEMAS: Record<string, ScaleConfigSchema> = {
	band: {
		padding: {
			type: 'number',
			range: [0, 1],
			strategy: RESOLUTION_STRATEGIES.MAX as (values: unknown[]) => unknown,
			description: 'Overall padding between category groups'
		},
		paddingInner: {
			type: 'number',
			range: [0, 1],
			strategy: RESOLUTION_STRATEGIES.MAX as (values: unknown[]) => unknown,
			description: 'Space between bars within a group'
		},
		paddingOuter: {
			type: 'number',
			range: [0, 1],
			strategy: RESOLUTION_STRATEGIES.MAX as (values: unknown[]) => unknown,
			description: 'Space before first and after last group'
		},
		transformKey: {
			type: 'string',
			strategy: RESOLUTION_STRATEGIES.FIRST_WINS as (values: unknown[]) => unknown,
			description: 'Transform-derived key for scale isolation (e.g. topN:5)'
		}
	},

	linear: {
		nice: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR as (values: unknown[]) => unknown,
			description: 'Extend domain to nice round numbers'
		},
		clamp: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR as (values: unknown[]) => unknown,
			description: 'Clamp values outside domain'
		},
		zero: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR as (values: unknown[]) => unknown,
			description: 'Include zero in domain'
		},
		domainMin: {
			type: 'number',
			strategy: RESOLUTION_STRATEGIES.MIN as (values: unknown[]) => unknown,
			description: 'Explicit minimum domain value'
		},
		domainMax: {
			type: 'number',
			strategy: RESOLUTION_STRATEGIES.MAX as (values: unknown[]) => unknown,
			description: 'Explicit maximum domain value'
		},
		disableZoom: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR as (values: unknown[]) => unknown,
			description: 'Disable user zoom/pan interactions (for auto-scaling axes)'
		}
	},

	point: {
		padding: {
			type: 'number',
			range: [0, 1],
			strategy: RESOLUTION_STRATEGIES.MAX as (values: unknown[]) => unknown,
			description: 'Padding around point scale range'
		}
	},

	time: {
		nice: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR as (values: unknown[]) => unknown,
			description: 'Extend domain to nice calendar boundaries'
		},
		clamp: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR as (values: unknown[]) => unknown,
			description: 'Clamp values outside domain'
		}
	},

	log: {
		nice: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR as (values: unknown[]) => unknown,
			description: 'Extend domain to nice powers'
		},
		domainMin: {
			type: 'number',
			strategy: RESOLUTION_STRATEGIES.MIN as (values: unknown[]) => unknown,
			description: 'Explicit minimum domain value (must be > 0)'
		},
		domainMax: {
			type: 'number',
			strategy: RESOLUTION_STRATEGIES.MAX as (values: unknown[]) => unknown,
			description: 'Explicit maximum domain value'
		},
		disableZoom: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR as (values: unknown[]) => unknown,
			description: 'Disable user zoom/pan interactions'
		}
	},

	symlog: {
		nice: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR as (values: unknown[]) => unknown,
			description: 'Extend domain to nice values'
		},
		constant: {
			type: 'number',
			strategy: RESOLUTION_STRATEGIES.FIRST_WINS as (values: unknown[]) => unknown,
			description: 'Symlog constant C (default 1). Controls linearity around zero.'
		},
		domainMin: {
			type: 'number',
			strategy: RESOLUTION_STRATEGIES.MIN as (values: unknown[]) => unknown,
			description: 'Explicit minimum domain value'
		},
		domainMax: {
			type: 'number',
			strategy: RESOLUTION_STRATEGIES.MAX as (values: unknown[]) => unknown,
			description: 'Explicit maximum domain value'
		},
		disableZoom: {
			type: 'boolean',
			strategy: RESOLUTION_STRATEGIES.BOOLEAN_OR as (values: unknown[]) => unknown,
			description: 'Disable user zoom/pan interactions'
		}
	}
};

/**
 * Validate a configuration value against its schema.
 */
export function validateConfigValue(value: unknown, schema: PropertySchema): boolean {
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

	return true;
}
