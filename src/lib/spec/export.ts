/**
 * Export the current chart state as a JSON spec.
 *
 * Reads ChartConfig entries and chart-level props, converts runtime values
 * back to spec format using the same types as the spec renderer.
 */

import type { ChartConfig, MarkEntry } from '$lib/config/ChartConfig.svelte';
import type { Transform } from '$lib/types';
import { fieldRefToSpec } from './ExpressionParser';
import { SPEC_MARK_TYPES, FIELD_CHANNELS, STROKE_AS_FIELD_MARKS } from './MarkRegistry';
import type { PlotSpec, MarkSpec, TransformSpec } from './types';

/** Props handled specially (not passthrough) or internal-only (skip entirely). */
const SKIP_PROPS = new Set([
	// Internal — not part of the spec
	'id',
	'markType',
	// Handled explicitly
	'table',
	'mark',
	'transforms',
	'selection',
	'stroke',
	'tip',
	'tooltip',
	'sort',
	// Field channels — converted via fieldRefToSpec
	...FIELD_CHANNELS
]);

// Default margin values (same as ChartContainer.svelte)
const DEFAULT_MARGIN = { top: 30, right: 50, bottom: 35, left: 75 };

/**
 * Export the full chart as a PlotSpec.
 * Reads all mark entries and chart-level props from ChartConfig.
 */
export function exportSpec(config: ChartConfig): PlotSpec {
	const marks: MarkSpec[] = [];
	for (const entry of config.entries.values()) {
		const markSpec = entryToMarkSpec(entry);
		if (markSpec) marks.push(markSpec);
	}

	const spec: PlotSpec = { marks };

	// Chart-level margins
	const cp = config.chartProps;
	if (cp) {
		const margin: Record<string, number> = {};
		if (cp.marginTop !== DEFAULT_MARGIN.top) margin.top = cp.marginTop;
		if (cp.marginRight !== DEFAULT_MARGIN.right) margin.right = cp.marginRight;
		if (cp.marginBottom !== DEFAULT_MARGIN.bottom) margin.bottom = cp.marginBottom;
		if (cp.marginLeft !== DEFAULT_MARGIN.left) margin.left = cp.marginLeft;
		if (Object.keys(margin).length > 0) spec.margin = margin;
	}

	return spec;
}

function entryToMarkSpec(entry: MarkEntry): MarkSpec | null {
	const specMarkType = SPEC_MARK_TYPES[entry.markType];
	if (!specMarkType) return null;

	const spec: Record<string, unknown> = {
		mark: specMarkType,
		table: entry.table
	};

	// Convert field channels (FieldRef → FieldSpec)
	for (const ch of FIELD_CHANNELS) {
		const val = entry[ch as keyof MarkEntry];
		if (val == null) continue;
		const converted = fieldRefToSpec(val);
		if (converted != null) spec[ch] = converted;
	}

	// stroke: data-driven on lines, CSS constant on areas
	if (entry.stroke != null) {
		if (STROKE_AS_FIELD_MARKS.has(entry.markType)) {
			const converted = fieldRefToSpec(entry.stroke);
			if (converted != null) spec.stroke = converted;
		} else if (typeof entry.stroke === 'string') {
			spec.stroke = entry.stroke;
		}
	}

	// All remaining enumerable props — passthrough if JSON-serializable
	for (const prop of Object.keys(entry)) {
		if (SKIP_PROPS.has(prop)) continue;
		if (prop in spec) continue; // already set above
		const val = (entry as Record<string, unknown>)[prop];
		if (val == null || typeof val === 'function') continue;
		spec[prop] = val;
	}

	// LOD: strip runtime-only properties (onLODChange callback) from exported spec
	if (spec.lod && typeof spec.lod === 'object') {
		const { onLODChange, ...lodSpec } = spec.lod as Record<string, unknown>;
		spec.lod = Object.keys(lodSpec).length > 0 ? lodSpec : true;
	}

	// Transforms — use stored spec, skip implicit stacks
	if (entry.transforms && Array.isArray(entry.transforms)) {
		const transformSpecs = serializeTransforms(entry.transforms);
		if (transformSpecs.length > 0) spec.transforms = transformSpecs;
	}

	// Selection (string name only — skip runtime Selection objects)
	if (entry.selection && typeof entry.selection === 'string') {
		spec.selection = entry.selection;
	}

	// Tip
	if (entry.tip === false) {
		spec.tip = false;
	} else if (Array.isArray(entry.tip)) {
		spec.tip = entry.tip.map((t) => (typeof t === 'string' ? t : String(t)));
	}

	// Sort
	if (entry.sort) spec.sort = entry.sort;

	// Tooltip
	if (entry.tooltip === false) spec.tooltip = false;

	return spec as unknown as MarkSpec;
}

function serializeTransforms(transforms: Transform[]): TransformSpec[] {
	const result: TransformSpec[] = [];
	for (const t of transforms) {
		// Skip implicit stack transforms (auto-injected by withImplicitStack)
		if (t.type === 'stack' && !t.spec) continue;
		if (t.spec) {
			result.push(t.spec as unknown as TransformSpec);
		}
	}
	return result;
}

/**
 * Export spec as a formatted JSON string ready for clipboard.
 * Returns just the PlotSpec — data sources are the caller's responsibility.
 */
export function exportSpecJSON(config: ChartConfig): string {
	return JSON.stringify(exportSpec(config), null, 2);
}
