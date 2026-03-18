/**
 * Maps mark type strings from JSON specs to Svelte mark components,
 * and resolves mark spec objects into component props.
 */

import type { Component } from 'svelte';
import DotsMark from '$lib/components/marks/DotsMark.svelte';
import BarMarkX from '$lib/components/marks/BarMarkX.svelte';
import BarMarkY from '$lib/components/marks/BarMarkY.svelte';
import LineMark from '$lib/components/marks/LineMark.svelte';
import AreaMarkY from '$lib/components/marks/AreaMarkY.svelte';
import AreaMarkX from '$lib/components/marks/AreaMarkX.svelte';
import RectMark from '$lib/components/marks/RectMark.svelte';
import RectXMark from '$lib/components/marks/RectXMark.svelte';
import RectYMark from '$lib/components/marks/RectYMark.svelte';
import TextMark from '$lib/components/marks/TextMark.svelte';
import { resolveFieldSpec } from './ExpressionParser';
import { parseTransforms } from './TransformParser';
import type { MarkSpec, FieldSpec } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MARK_REGISTRY: Record<string, Component<any>> = {
	dot: DotsMark,
	barX: BarMarkX,
	barY: BarMarkY,
	line: LineMark,
	areaY: AreaMarkY,
	areaX: AreaMarkX,
	rect: RectMark,
	rectX: RectXMark,
	rectY: RectYMark,
	text: TextMark
};

/** Channel prop names that hold FieldSpec values and need resolution. */
export const FIELD_CHANNELS = new Set(['x', 'x1', 'x2', 'y', 'y1', 'y2', 'fill', 'r', 'z', 'text']);

/** Mark types where `stroke` is a data-driven FieldSpec (not a CSS constant). */
export const STROKE_AS_FIELD_MARKS = new Set(['line']);

/** Internal mark type → spec mark type. Used by both resolveMarkEntry and exportSpec. */
export const SPEC_MARK_TYPES: Record<string, string> = {
	dot: 'dot',
	line: 'line',
	rect: 'rect',
	bary: 'barY',
	barx: 'barX',
	areay: 'areaY',
	areax: 'areaX',
	recty: 'rectY',
	rectx: 'rectX',
	text: 'text'
};

/**
 * Convert a MarkSpec into { component, props } for svelte:component rendering.
 * Resolves FieldSpecs, transforms, and selection references.
 */
export function resolveMarkEntry(markSpec: MarkSpec): {
	component: Component;
	props: Record<string, unknown>;
} {
	const component = MARK_REGISTRY[markSpec.mark];
	if (!component) {
		throw new Error(
			`Unknown mark type: "${markSpec.mark}". Valid types: ${Object.keys(MARK_REGISTRY).join(', ')}`
		);
	}

	// Shallow copy, then strip the discriminant
	const props: Record<string, unknown> = { ...markSpec };
	delete props.mark;

	// Resolve FieldSpec channels → FieldRef values
	for (const key of FIELD_CHANNELS) {
		if (key in props && props[key] != null) {
			// Numbers are constants (e.g. r=3), not field references — skip resolution
			if (typeof props[key] === 'number') continue;
			props[key] = resolveFieldSpec(props[key] as FieldSpec);
		}
	}

	// stroke is data-driven (FieldSpec) on lines, but a CSS constant on areas
	if (STROKE_AS_FIELD_MARKS.has(markSpec.mark) && props.stroke != null) {
		props.stroke = resolveFieldSpec(props.stroke as FieldSpec);
	}

	// Resolve transforms
	if (props.transforms && Array.isArray(props.transforms)) {
		props.transforms = parseTransforms(props.transforms);
	}

	// Resolve FieldSpec entries in tip (e.g., { aggregate: "min", field: "value" } → Mosaic node)
	// Also resolves labeled entries: { value: { aggregate: "min", field: "v" }, label: "Min" }
	if (props.tip && Array.isArray(props.tip)) {
		props.tip = (props.tip as unknown[]).map((entry) => {
			if (typeof entry === 'string') return entry;
			if (typeof entry === 'object' && entry !== null) {
				// Labeled entry
				if ('value' in entry && 'label' in entry) {
					const labeled = entry as { value: unknown; label: string };
					if (typeof labeled.value === 'object' && labeled.value !== null && 'aggregate' in labeled.value) {
						return { value: resolveFieldSpec(labeled.value as FieldSpec), label: labeled.label };
					}
					return entry;
				}
				// Raw aggregate
				if ('aggregate' in entry) {
					return resolveFieldSpec(entry as FieldSpec);
				}
			}
			return entry;
		});
	}

	// selection stays as a string — mark components resolve it from SelectionRegistry context
	return { component, props };
}
