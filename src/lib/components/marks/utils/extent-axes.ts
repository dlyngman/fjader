/**
 * The extent axes of bar and rect marks: what each may draw, and what it says
 * when given something it cannot.
 *
 * A bar spans a band (one row per category) and a value axis. A rect spans two
 * continuous extents, each from bin() or from explicit edges. A category on a
 * rect mark's extent axis is a bar's job.
 */
import { isBinExpression } from '$lib/sql/bin';
import type { FieldRef } from '$lib/types';

/**
 * A bar's value axis. With both ends given as columns (x1 and x2), the axis
 * follows the start column's type, so date columns draw a timeline on a time
 * axis. A length from zero (x alone, or a stack) is linear at once, without
 * waiting for the schema; a date there has no zero to start from.
 *
 * `inferred` is the start column's type for explicit ends (null while the
 * schema loads), the value column's otherwise (null when not known yet, which
 * does not hold a length back).
 */
export function barValueAxis(
	mark: string,
	axis: 'x' | 'y',
	ends: { lo: number | FieldRef | null | undefined; hi: FieldRef | null | undefined },
	explicit: boolean,
	inferred: string | null
): { type: 'linear' | 'time' | null; error: string | null } {
	const { lo, hi } = ends;
	if (!explicit) {
		if (inferred !== 'time') return { type: 'linear', error: null };
		return {
			type: null,
			error:
				`${mark}: ${axis}="${String(hi)}" is a date, and a bar from zero has no meaning on ` +
				`a time axis. Give both ends: ${axis}1 and ${axis}2.`
		};
	}
	if (typeof lo !== 'number' && lo != null && hi != null) {
		if (inferred === null) return { type: null, error: null };
		return { type: inferred === 'time' ? 'time' : 'linear', error: null };
	}
	// One end a constant or missing: a length, as before.
	return { type: 'linear', error: null };
}

/**
 * A rect mark's extent on one axis: from bin(), else from explicit edges. A
 * plain channel has no extent; on a category it is a bar's band.
 */
export function rectExtent(
	mark: string,
	axis: 'x' | 'y',
	value: unknown,
	edges: { lo: unknown; hi: unknown }
): { lo: FieldRef | null; hi: FieldRef | null; error: string | null } {
	if (value == null) {
		return { lo: (edges.lo as FieldRef) ?? null, hi: (edges.hi as FieldRef) ?? null, error: null };
	}
	if (isBinExpression(value)) {
		// A bin node travels as a channel value, as it always has (inferMarkScaleType
		// and the lifecycle unwrap it).
		const lo = value as unknown as FieldRef;
		return { lo, hi: value.withOffset(1) as unknown as FieldRef, error: null };
	}
	const bar = axis === 'y' ? 'BarMarkX' : 'BarMarkY';
	return {
		lo: null,
		hi: null,
		error:
			`${mark}: ${axis}="${String(value)}" has no extent. A rect spans ${axis}1 to ${axis}2, ` +
			`or bin("${String(value)}"); for one row per category, use ${bar}.`
	};
}
