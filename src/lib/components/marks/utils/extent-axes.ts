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

/** The scale type of each end: undefined for an end not given, null while its schema loads. */
export type EndTypes = { lo: string | null | undefined; hi: string | null | undefined };

/**
 * A bar's value axis. With explicit ends (x1, x2) that are both date columns,
 * a time axis: a timeline. A date at only one end (the other missing, a
 * constant, or a number) has no time axis to share and is refused. Otherwise
 * linear, as before.
 *
 * A length from zero (x alone, or a stack) is linear at once, without waiting
 * for the schema; a date there has no zero to start from, and is refused once
 * its type is known. Explicit ends wait while a column end's type is unknown.
 *
 * Only date columns make a time axis: an expression end is linear (as
 * inferMarkScaleType has it), dates or not.
 */
export function barValueAxis(
	mark: string,
	axis: 'x' | 'y',
	ends: { lo: unknown; hi: unknown },
	explicit: boolean,
	types: EndTypes
): { type: 'linear' | 'time' | null; error: string | null } {
	const linear = { type: 'linear', error: null } as const;
	if (!explicit) {
		if (types.hi !== 'time') return linear;
		return {
			type: null,
			error:
				`${mark}: ${axis}=${describe(ends.hi)} is a date, and a bar from zero has no meaning on ` +
				`a time axis. Give both ends: ${axis}1 and ${axis}2.`
		};
	}
	if (types.lo === null || types.hi === null) return { type: null, error: null };
	const loTime = types.lo === 'time';
	const hiTime = types.hi === 'time';
	if (loTime && hiTime) return { type: 'time', error: null };
	if (!loTime && !hiTime) return linear;
	return {
		type: null,
		error:
			`${mark}: ${axis}1=${describe(ends.lo)} and ${axis}2=${describe(ends.hi)}: a bar on a time ` +
			`axis needs both ends as date columns.`
	};
}

/** An end as written: a column name quoted, a constant as is, none said so. */
function describe(end: unknown): string {
	if (end == null) return '(none)';
	return typeof end === 'string' ? `"${end}"` : String(end);
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
			`or bin("${String(value)}"); for one row per category, use ${bar}. (A grid of two ` +
			`categories has no mark yet.)`
	};
}
