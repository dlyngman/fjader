import type { JsColumnType } from '$lib/data/TableSchemaService.svelte';
import type { MarkEntry } from '$lib/config/ChartConfig.svelte';
import { getAllSchemeNames } from '$lib/scales/color-utils';

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

// ---- Option value lists (derived from runtime sources) ----

type OptionValue = { value: string | null; label: string };
const AUTO: OptionValue = { value: null, label: 'auto' };

function buildSchemeOptions(): OptionValue[] {
	const s = getAllSchemeNames();
	const opts: OptionValue[] = [AUTO];
	for (const name of s.ordinal) opts.push({ value: name, label: name });
	for (const name of s.sequential) opts.push({ value: name, label: name });
	for (const name of s.diverging) opts.push({ value: name, label: name });
	for (const name of s.cyclical) opts.push({ value: name, label: name });
	return opts;
}

// User-facing curve names (excludes axis-specific variants like monotone-x/bump-x).
const USER_CURVES = ['linear', 'step', 'step-before', 'step-after', 'monotone', 'catmull-rom', 'bump'];

function buildCurveOptions(): OptionValue[] {
	return [AUTO, ...USER_CURVES.map((c) => ({ value: c, label: c }))];
}

const SCHEME_OPTIONS = buildSchemeOptions();
const CURVE_OPTIONS = buildCurveOptions();

// ---- Option channels (enum pickers, not column assignment) ----

/** An option channel maps a display name → a MarkEntry prop with a fixed set of values. */
export interface OptionChannelDef {
	/** MarkEntry property to read/write */
	prop: string;
	/** Fixed options (value=null means "auto"/unset) */
	options: Array<{ value: string | null; label: string }>;
	/**
	 * If set, options are resolved dynamically from schema + entry.
	 * Overrides the static `options` list.
	 */
	dynamic?: 'scaleType';
}

// Per-mark option channels, keyed by mark type.
// These appear after column channels in the mark tab.
const MARK_OPTION_CHANNELS: Record<string, Record<string, OptionChannelDef>> = {
	dot: {
		scheme: { prop: 'scheme', options: SCHEME_OPTIONS }
	},
	line: {
		scheme: { prop: 'scheme', options: SCHEME_OPTIONS },
		curve: { prop: 'curve', options: CURVE_OPTIONS }
	},
	areay: {
		scheme: { prop: 'scheme', options: SCHEME_OPTIONS },
		curve: { prop: 'curve', options: CURVE_OPTIONS }
	},
	areax: {
		scheme: { prop: 'scheme', options: SCHEME_OPTIONS },
		curve: { prop: 'curve', options: CURVE_OPTIONS }
	},
	bary: { scheme: { prop: 'scheme', options: SCHEME_OPTIONS } },
	barx: { scheme: { prop: 'scheme', options: SCHEME_OPTIONS } },
	recty: { scheme: { prop: 'scheme', options: SCHEME_OPTIONS } },
	rectx: { scheme: { prop: 'scheme', options: SCHEME_OPTIONS } },
	rect: { scheme: { prop: 'scheme', options: SCHEME_OPTIONS } }
};

export function getOptionChannels(markType: string): Record<string, OptionChannelDef> {
	return MARK_OPTION_CHANNELS[markType] ?? {};
}

// ---- Chart-level channels (applied to all marks) ----

export const CHART_CHANNELS = ['x scale', 'y scale'] as const;
export type ChartChannel = (typeof CHART_CHANNELS)[number];

export const CHART_CHANNEL_DEFS: Record<ChartChannel, OptionChannelDef> = {
	'x scale': { prop: 'preferredXScaleType', options: [], dynamic: 'scaleType' },
	'y scale': { prop: 'preferredYScaleType', options: [], dynamic: 'scaleType' }
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
