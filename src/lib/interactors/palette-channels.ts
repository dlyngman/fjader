import type { JsColumnType } from '$lib/data/TableSchemaService.svelte';

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
