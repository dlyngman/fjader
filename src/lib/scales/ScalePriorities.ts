import {
	SCALE_CONFIG_SCHEMAS,
	validateConfigValue,
	type PropertySchema
} from './ScaleConfigurationSchemas';

export const SCALE_PRIORITIES = {
	MANDATE: 3,
	PREFER: 2,
	ACCEPT: 1,
	DEFAULT: 0
} as const;

export interface ScaleRequirement {
	type: string;
	priority?: number;
	markId?: string;
	columnName?: string;
	/** The column is an aggregate (count(), sum(x)): its axis is chart-local unless named. */
	aggregate?: boolean;
	/**
	 * What the mark would title the axis: its column's bare name; null for an
	 * expression, which has no name to show; absent for a constant, which has
	 * no say (a rule at 10).
	 */
	title?: string | null;
	config?: Record<string, unknown>;
}

/** A fully populated scale requirement as stored by ChartScales after registration. */
export interface RegisteredScaleRequirement {
	type: string;
	priority: number;
	markId: string;
	config: Record<string, unknown>;
	columnName: string | null;
	aggregate: boolean;
	title?: string | null;
}

export interface ResolvedScaleConfiguration {
	type: string;
	config: Record<string, unknown>;
	columnName: string | null;
	/** Whether any requirement on the axis names an aggregate, whatever order they registered in. */
	aggregate: boolean;
	/** The axis's title without a label: the one column all its marks show, else null. */
	title: string | null;
}

export function resolveScaleType(requirements: ScaleRequirement[] | null): string {
	if (!requirements || requirements.length === 0) {
		return 'linear';
	}

	const byPriority: Record<number, ScaleRequirement[]> = {};
	for (const req of requirements) {
		const priority = req.priority || SCALE_PRIORITIES.DEFAULT;
		if (!byPriority[priority]) byPriority[priority] = [];
		byPriority[priority].push(req);
	}

	const priorities = Object.keys(byPriority)
		.map((p) => parseInt(p))
		.sort((a, b) => b - a);

	const highestPriority = priorities[0];
	const topRequirements = byPriority[highestPriority];

	const uniqueTypes = [...new Set(topRequirements.map((req) => req.type))];

	if (uniqueTypes.length > 1) {
		const markTypes = topRequirements.map((req) => req.markId).join(', ');
		const conflictTypes = uniqueTypes.join(' vs ');

		throw new Error(
			`Scale type conflict: marks [${markTypes}] require incompatible scale types [${conflictTypes}]. ` +
				`Consider using separate ChartContainers or different mark types.`
		);
	}

	return uniqueTypes[0];
}

export function resolveScaleConfiguration(
	requirements: ScaleRequirement[] | null
): ResolvedScaleConfiguration | null {
	if (!requirements || requirements.length === 0) {
		return null;
	}

	const resolvedType = resolveScaleType(requirements);

	const typeRequirements = requirements.filter((req) => req.type === resolvedType);
	const resolvedConfig = resolveConfigurationForType(typeRequirements, resolvedType);

	const sorted = [...typeRequirements].sort((a, b) => (b.priority || 0) - (a.priority || 0));
	const columnName = sorted.find((req) => req.columnName)?.columnName || null;
	// Any, not the one that named the column: that is registration order at equal
	// priority, and an axis showing a count is not the other column's axis.
	const aggregate = requirements.some((req) => req.aggregate);
	// Only when they agree: never SQL, and never whichever column mounted first.
	const titles = new Set(requirements.map((req) => req.title).filter((t) => t !== undefined));
	const title = titles.size === 1 ? ([...titles][0] ?? null) : null;

	return { type: resolvedType, config: resolvedConfig, columnName, aggregate, title };
}

function resolveConfigurationForType(
	requirements: ScaleRequirement[],
	scaleType: string
): Record<string, unknown> {
	const schema = SCALE_CONFIG_SCHEMAS[scaleType];
	if (!schema) {
		console.warn(`No configuration schema found for scale type: ${scaleType}`);
		return {};
	}

	const configs = requirements.map((req) => req.config || {});
	const resolvedConfig: Record<string, unknown> = {};

	for (const [propName, propSchema] of Object.entries(schema) as [string, PropertySchema][]) {
		const values = configs.map((config) => config[propName]).filter((val) => val != null);

		if (values.length === 0) continue;

		const validValues: unknown[] = [];
		for (const value of values) {
			if (validateConfigValue(value, propSchema)) {
				validValues.push(value);
			} else {
				console.warn(`Invalid ${propName} value for ${scaleType} scale:`, {
					value,
					expected: propSchema.type,
					range: propSchema.range,
					description: propSchema.description
				});
			}
		}

		if (validValues.length === 0) continue;

		try {
			resolvedConfig[propName] = propSchema.strategy(validValues);
		} catch (error) {
			console.error(`Failed to resolve ${scaleType}.${propName}:`, (error as Error).message);
			throw new Error(
				`Configuration resolution failed for ${scaleType}.${propName}: ${(error as Error).message}`,
				{ cause: error }
			);
		}
	}

	return resolvedConfig;
}
