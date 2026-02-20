import { isColorConstant, type RGBA } from '$lib/scales/color-utils';
import type { Column } from '@uwdata/flechette';

export type SourceType = 'constant' | 'constant-color' | 'array' | 'float32array' | 'sql';

type RGB = [number, number, number];

export function getSourceType(value: unknown): SourceType {
	if (typeof value === 'number') return 'constant';
	if (typeof value === 'string' && isColorConstant(value)) return 'constant-color';
	if (Array.isArray(value)) return 'array';
	if (value instanceof Float32Array) return 'float32array';
	return 'sql';
}

const processors: Record<string, (value: unknown, instanceCount?: number) => Float32Array | null> = {
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

export function parseColor(color: string): RGBA {
	if (color.startsWith('#')) {
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
		const rgb = COLOR_NAME_RGB.get(color.toLowerCase());
		if (rgb) return [...rgb, 1.0];
	}
	return [0.2, 0.4, 0.8, 1.0];
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
			const parsed = parseColor(value as string);
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
				const parsed = parseColor(fillColor);
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
	const defaultColor = [0.2, 0.4, 0.8, 1.0];
	for (let i = 0; i < instanceCount; i++) {
		rgba.set(defaultColor, i * 4);
	}
	return rgba;
}

const COLOR_NAME_RGB = new Map<string, RGB>([
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
]);
