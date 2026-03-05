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
const FIELD_CHANNELS = new Set(['x', 'x1', 'x2', 'y', 'y1', 'y2', 'fill', 'r', 'z', 'text']);

/** Mark types where `stroke` is a data-driven FieldSpec (not a CSS constant). */
const STROKE_AS_FIELD_MARKS = new Set(['line']);

/**
 * Convert a MarkSpec into { component, props } for svelte:component rendering.
 * Resolves FieldSpecs, transforms, and selection references.
 */
export function resolveMarkEntry(
	markSpec: MarkSpec
): { component: Component; props: Record<string, unknown> } {
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

	// selection stays as a string — mark components resolve it from SelectionRegistry context
	return { component, props };
}
