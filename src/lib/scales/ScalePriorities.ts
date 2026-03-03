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
	config?: Record<string, unknown>;
}

/** A fully populated scale requirement as stored by ChartScales after registration. */
export interface RegisteredScaleRequirement {
	type: string;
	priority: number;
	markId: string;
	config: Record<string, unknown>;
	columnName: string | null;
}

export interface ResolvedScaleConfiguration {
	type: string;
	config: Record<string, unknown>;
	columnName: string | null;
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

	console.log(`🎯 Resolved scale configuration:`, {
		type: resolvedType,
		config: resolvedConfig,
		columnName,
		fromRequirements: typeRequirements.length
	});

	return { type: resolvedType, config: resolvedConfig, columnName };
}

function resolveConfigurationForType(
	requirements: ScaleRequirement[],
	scaleType: string
): Record<string, unknown> {
	const schema = SCALE_CONFIG_SCHEMAS[scaleType];
	if (!schema) {
		console.warn(`⚠️ No configuration schema found for scale type: ${scaleType}`);
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
				console.warn(`❌ Invalid ${propName} value for ${scaleType} scale:`, {
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
			console.log(`🔧 Resolved ${scaleType}.${propName}: ${resolvedConfig[propName]}`, {
				strategy: propSchema.strategy.name || 'custom',
				fromValues: validValues,
				description: propSchema.description
			});
		} catch (error) {
			console.error(`❌ Failed to resolve ${scaleType}.${propName}:`, (error as Error).message);
			throw new Error(
				`Configuration resolution failed for ${scaleType}.${propName}: ${(error as Error).message}`,
				{ cause: error }
			);
		}
	}

	return resolvedConfig;
}
