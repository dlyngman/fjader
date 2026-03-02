// Centralized scale type classification.
// When adding a new scale type, update the relevant Set(s) here.

const CONTINUOUS = new Set(['linear', 'log', 'symlog', 'time']);
const NUMERIC = new Set(['linear', 'log', 'symlog']);
const CATEGORICAL = new Set(['band', 'point']);
const TEMPORAL = new Set(['time', 'utc']);

/** Has a numeric domain that supports pan/zoom (linear, log, symlog, time). */
export function isContinuousScale(type: string | null | undefined): boolean {
	return type != null && CONTINUOUS.has(type);
}

/** Continuous numeric, excluding time (linear, log, symlog). */
export function isNumericScale(type: string | null | undefined): boolean {
	return type != null && NUMERIC.has(type);
}

/** Categorical axis (band, point). */
export function isCategoricalScale(type: string | null | undefined): boolean {
	return type != null && CATEGORICAL.has(type);
}

/** Time-based axis (time, utc). */
export function isTemporalScale(type: string | null | undefined): boolean {
	return type != null && TEMPORAL.has(type);
}

/** Domain must be strictly positive (log). */
export function requiresPositiveDomain(type: string | null | undefined): boolean {
	return type === 'log';
}
