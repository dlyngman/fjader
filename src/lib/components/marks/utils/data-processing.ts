import {
	isColorConstant,
	parseColorToRGBA,
	DEFAULT_FILL_COLOR,
	type RGBA
} from '$lib/scales/color-utils';
import type { Column } from '@uwdata/flechette';

export type SourceType = 'constant' | 'constant-color' | 'array' | 'float32array' | 'sql';

export function getSourceType(value: unknown): SourceType {
	if (typeof value === 'number') return 'constant';
	if (typeof value === 'string' && isColorConstant(value)) return 'constant-color';
	if (Array.isArray(value)) return 'array';
	if (value instanceof Float32Array) return 'float32array';
	return 'sql';
}

const processors: Record<string, (value: unknown, instanceCount?: number) => Float32Array | null> =
	{
		constant: (value: unknown, instanceCount?: number) =>
			new Float32Array(instanceCount!).fill(value as number),
		array: (value: unknown) => new Float32Array(value as number[]),
		float32array: (value: unknown) => value as Float32Array,
		sql: (column: unknown) => {
			if (!column) return null;
			const rawArray = (column as Column<unknown>).toArray();
			return rawArray instanceof Float32Array ? rawArray : new Float32Array(rawArray as number[]);
		}
	};

export function processData(
	value: unknown,
	column: Column<unknown> | null,
	instanceCount: number,
	strategy: SourceType | null = null
): Float32Array | null {
	const type = strategy || getSourceType(value);
	if (!type) return null;

	if (type === 'constant') return processors.constant(value as number, instanceCount);
	if (type === 'sql') return processors.sql(column);
	return processors[type](value);
}

export function processAlphaData(
	alpha: unknown,
	instanceCount: number,
	strategy: SourceType | null = null
): Float32Array | null {
	if (!instanceCount) return null;

	const type = strategy || getSourceType(alpha);

	switch (type) {
		case 'constant': {
			const alphas = new Float32Array(instanceCount);
			alphas.fill(alpha as number);
			return alphas;
		}

		case 'sql':
			return null;

		default: {
			const defaultAlphas = new Float32Array(instanceCount);
			defaultAlphas.fill(0.8);
			return defaultAlphas;
		}
	}
}

export function buildSelectFromChannels(
	channels: Record<string, unknown>
): Record<string, unknown> {
	const select: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(channels)) {
		if (value !== undefined && getSourceType(value) === 'sql') {
			select[key] = value;
		}
	}

	return select;
}

export function buildConstantsFromChannels(
	channels: Record<string, unknown>
): Record<string, number> | null {
	let constants: Record<string, number> | null = null;
	for (const [key, value] of Object.entries(channels)) {
		if (typeof value === 'number') {
			if (!constants) constants = {};
			constants[key] = value;
		}
	}
	return constants;
}

export function processColorData(
	value: unknown,
	column: Column<unknown> | null,
	instanceCount: number,
	colorScale: ((value: unknown) => string) | null = null,
	strategy: SourceType | null = null
): Float32Array | null {
	if (!instanceCount) return null;

	const sourceType = strategy || getSourceType(value);
	const rgba = new Float32Array(instanceCount * 4);

	switch (sourceType) {
		case 'constant-color': {
			const parsed = parseColorToRGBA(value as string);
			for (let i = 0; i < instanceCount; i++) {
				rgba.set(parsed, i * 4);
			}
			return rgba;
		}

		case 'sql': {
			if (!column || !colorScale) {
				return getDefaultColorData(instanceCount);
			}

			const colorArray = column.toArray();
			for (let i = 0; i < instanceCount; i++) {
				const colorValue = colorArray[i];
				const fillColor = colorScale(colorValue);
				const parsed = parseColorToRGBA(fillColor);
				rgba.set(parsed, i * 4);
			}
			return rgba;
		}

		default:
			return getDefaultColorData(instanceCount);
	}
}

function getDefaultColorData(instanceCount: number): Float32Array {
	const rgba = new Float32Array(instanceCount * 4);
	const defaultColor = DEFAULT_FILL_COLOR;
	for (let i = 0; i < instanceCount; i++) {
		rgba.set(defaultColor, i * 4);
	}
	return rgba;
}
