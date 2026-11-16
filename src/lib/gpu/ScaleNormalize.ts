/**
 * A continuous scale's domain step, as WGSL expressions: `normalize` takes a
 * data value to [0, 1] across the domain, `invert` takes it back.
 *
 * The vertex stage draws a value through `normalize` and then the range step
 * (ScaleTemplateSystem); the pixel-space resolve (ResolveShader) mixes the
 * positions of values drawn under two domains and maps the result back with
 * `invert`, and the remap (RemapShader) re-expresses a value in another
 * domain. All paste these same expressions, so a resolved value is drawn by
 * the code that placed it: the resolve and the draw cannot disagree about what
 * a domain means.
 *
 * `scale` names a `ScaleParam` (p1..p4, as `#writeScaleParam` packs a scale's
 * `gpuState`). Time scales are linear in offsets from t0.
 */

/** The continuous scale kinds the GPU draws, as their params are packed. */
export type FoldScaleKind = 'linear' | 'log' | 'symlog';

/** The kind a scale type draws with on the GPU, or null for one that does not fold (band, …). */
export function foldScaleKind(scaleType: string | undefined): FoldScaleKind | null {
	switch (scaleType) {
		case 'linear':
		case 'time':
			return 'linear';
		case 'log':
			return 'log';
		case 'symlog':
			return 'symlog';
		default:
			return null;
	}
}

/**
 * `value` in [0, 1] across the domain in `scale`:
 * - linear: p1 = domain min, p3 = 1 / (max − min);
 * - log: p1, p3 the same over ln(domain);
 * - symlog: p1, p3 the same over symlog(domain), p4 = the constant C.
 */
export function normalizeExpr(kind: FoldScaleKind, value: string, scale: string): string {
	switch (kind) {
		case 'linear':
			return `((${value}) - ${scale}.p1) * ${scale}.p3`;
		case 'log':
			return `(log(max(${value}, 1e-38)) - ${scale}.p1) * ${scale}.p3`;
		case 'symlog':
			return `((sign(${value}) * log(1.0 + abs((${value}) / ${scale}.p4))) - ${scale}.p1) * ${scale}.p3`;
	}
}

/** The data value at `normalized` across the domain in `scale`: `normalizeExpr`'s inverse. */
export function invertExpr(kind: FoldScaleKind, normalized: string, scale: string): string {
	const along = `(${scale}.p1 + (${normalized}) / ${scale}.p3)`;
	switch (kind) {
		case 'linear':
			return along;
		case 'log':
			return `exp${along}`;
		case 'symlog':
			return `(sign${along} * ${scale}.p4 * (exp(abs${along}) - 1.0))`;
	}
}

/** `normalizeExpr` in JS, for references and tests: the same arithmetic, in f64. */
export function normalizeReference(
	kind: FoldScaleKind,
	value: number,
	p: ArrayLike<number>
): number {
	switch (kind) {
		case 'linear':
			return (value - p[0]) * p[2];
		case 'log':
			return (Math.log(Math.max(value, 1e-38)) - p[0]) * p[2];
		case 'symlog':
			return (Math.sign(value) * Math.log(1 + Math.abs(value / p[3])) - p[0]) * p[2];
	}
}

/** `invertExpr` in JS. */
export function invertReference(
	kind: FoldScaleKind,
	normalized: number,
	p: ArrayLike<number>
): number {
	const along = p[0] + normalized / p[2];
	switch (kind) {
		case 'linear':
			return along;
		case 'log':
			return Math.exp(along);
		case 'symlog':
			return Math.sign(along) * p[3] * (Math.exp(Math.abs(along)) - 1);
	}
}
