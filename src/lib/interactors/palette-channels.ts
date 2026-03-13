import type { JsColumnType } from '$lib/data/TableSchemaService.svelte';
import type { MarkEntry } from '$lib/config/ChartConfig.svelte';

// Which entry keys are column-assignable channels (accept a FieldRef).
// Derived from each mark's registerMark() call. Order = display order in palette.
const COLUMN_CHANNELS: Record<string, string[]> = {
	dot: ['x', 'y', 'fill', 'r'],
	line: ['x', 'y', 'stroke', 'z'],
	areay: ['x', 'y', 'fill', 'z'],
	areax: ['x', 'y', 'fill', 'z'],
	bary: ['x', 'y', 'fill'],
	barx: ['x', 'y', 'fill'],
	recty: ['x', 'y', 'fill'],
	rectx: ['x', 'y', 'fill'],
	rect: ['x', 'y', 'fill']
};

// Static type constraints per channel (non-positional channels).
const CHANNEL_ACCEPTS: Record<string, JsColumnType[]> = {
	fill: ['string', 'number'],
	stroke: ['string', 'number'],
	z: ['string'],
	r: ['number']
};

// Scale type → compatible JS column types.
// TODO: Support scale type re-resolution so the palette can offer cross-type
// assignments (e.g. switching x from linear→band). Currently we filter to
// types compatible with the *active* scale to avoid errors.
const SCALE_TYPE_ACCEPTS: Record<string, JsColumnType[]> = {
	linear: ['number'],
	log: ['number'],
	symlog: ['number'],
	time: ['date'],
	band: ['string'],
	// Fallback for unknown/null scale types — allow everything
	unknown: ['number', 'string', 'date']
};

export interface ScaleTypeHint {
	x?: string | null;
	y?: string | null;
}

export function getAssignableChannels(markType: string): string[] {
	return COLUMN_CHANNELS[markType] ?? [];
}

export interface ColumnOption {
	name: string;
	jsType: JsColumnType;
	sqlType: string;
}

// ---- Chart-level channels (scale type overrides) ----

export const CHART_CHANNELS = ['x scale', 'y scale'] as const;
export type ChartChannel = (typeof CHART_CHANNELS)[number];

export const CHART_CHANNEL_TO_PROP: Record<ChartChannel, string> = {
	'x scale': 'preferredXScaleType',
	'y scale': 'preferredYScaleType'
};

// Scale types compatible with each JS column type.
const JSTYPE_SCALE_TYPES: Record<JsColumnType, Array<{ value: string; label: string }>> = {
	number: [
		{ value: 'linear', label: 'linear' },
		{ value: 'log', label: 'log' },
		{ value: 'symlog', label: 'symlog' }
	],
	string: [{ value: 'band', label: 'band' }],
	date: [{ value: 'time', label: 'time' }],
	boolean: [],
	other: []
};

/**
 * Return scale types compatible with the column currently bound to the given axis.
 * Always includes "auto" (null) as first option.
 */
export function getCompatibleScaleTypes(
	schema: Map<string, { sqlType: string; jsType: JsColumnType }>,
	axis: 'x' | 'y',
	entry: MarkEntry
): Array<{ value: string | null; label: string }> {
	const result: Array<{ value: string | null; label: string }> = [
		{ value: null, label: 'auto' }
	];

	const column = entry[axis];
	if (!column || typeof column !== 'string') return result;

	const info = schema.get(column);
	if (!info) return result;

	const types = JSTYPE_SCALE_TYPES[info.jsType] ?? [];
	result.push(...types);
	return result;
}

export function getCompatibleColumns(
	schema: Map<string, { sqlType: string; jsType: JsColumnType }>,
	channel: string,
	scaleTypes?: ScaleTypeHint | null
): ColumnOption[] {
	let accepts: JsColumnType[];

	if (channel === 'x' || channel === 'y') {
		const scaleType = scaleTypes?.[channel] ?? null;
		accepts = SCALE_TYPE_ACCEPTS[scaleType ?? 'unknown'] ?? SCALE_TYPE_ACCEPTS.unknown;
	} else {
		accepts = CHANNEL_ACCEPTS[channel] ?? ['number', 'string', 'date'];
	}

	const result: ColumnOption[] = [];
	for (const [name, info] of schema) {
		if (accepts.includes(info.jsType)) {
			result.push({ name, jsType: info.jsType, sqlType: info.sqlType });
		}
	}
	return result;
}
