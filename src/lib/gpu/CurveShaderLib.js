// src/lib/gpu/CurveShaderLib.js

/**
 * Curve interpolation shader library for GPU-side segment evaluation.
 *
 * Each curve type is a separate WGSL string selected at shader compilation time.
 * No runtime branching — different curve types produce different compiled shaders.
 *
 * All implementations share the same 4-point signature:
 *   evaluateCurve(p0, p1, p2, p3, t) -> vec2<f32>
 *
 * - p0: previous point (before segment start) — used by catmull-rom, basis, monotone
 * - p1: segment start point — used by all
 * - p2: segment end point — used by all
 * - p3: point after segment end — used by catmull-rom, basis, monotone
 * - t:  interpolation parameter [0, 1]
 *
 * 4 points is sufficient for all local interpolation methods (linear, step,
 * catmull-rom, cardinal, basis, monotone). Only global methods like natural
 * cubic spline (requiring ALL points) don't fit this signature.
 */

// Linear: identity interpolation. Ignores p0/p3.
export const CURVE_LINEAR = /* wgsl */ `
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	return mix(p1, p2, t);
}
`;

// Step-after: horizontal at p1.y, then vertical to p2.y. Ignores p0/p3.
export const CURVE_STEP_AFTER = /* wgsl */ `
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	if (t < 0.5) {
		return vec2<f32>(mix(p1.x, p2.x, t * 2.0), p1.y);
	} else {
		return vec2<f32>(p2.x, mix(p1.y, p2.y, (t - 0.5) * 2.0));
	}
}
`;

// Step-before: vertical to p2.y first, then horizontal. Ignores p0/p3.
export const CURVE_STEP_BEFORE = /* wgsl */ `
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	if (t < 0.5) {
		return vec2<f32>(p1.x, mix(p1.y, p2.y, t * 2.0));
	} else {
		return vec2<f32>(mix(p1.x, p2.x, (t - 0.5) * 2.0), p2.y);
	}
}
`;

// Step: midpoint step. Three continuous segments: horizontal at p1.y → vertical → horizontal at p2.y.
// Requires resolution=3 so each segment gets its own sub-quad with correct tangent.
export const CURVE_STEP = /* wgsl */ `
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	let midX = mix(p1.x, p2.x, 0.5);
	let third = 1.0 / 3.0;
	if (t < third) {
		let lt = t * 3.0;
		return vec2<f32>(mix(p1.x, midX, lt), p1.y);
	} else if (t < third * 2.0) {
		let lt = (t - third) * 3.0;
		return vec2<f32>(midX, mix(p1.y, p2.y, lt));
	} else {
		let lt = (t - third * 2.0) * 3.0;
		return vec2<f32>(mix(midX, p2.x, lt), p2.y);
	}
}
`;

// Catmull-Rom spline: cubic interpolation using all 4 control points.
// Standard Catmull-Rom matrix (tau = 0.5). Note: overshoots at local extrema
// by design — use 'monotone' curve type if overshoot-free interpolation is needed.
export const CURVE_CATMULL_ROM = /* wgsl */ `
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	let t2 = t * t;
	let t3 = t2 * t;
	// Catmull-Rom basis matrix (tau = 0.5)
	let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
	let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
	let c = -0.5 * p0 + 0.5 * p2;
	let d = p1;
	return a * t3 + b * t2 + c * t + d;
}
`;

// Monotone cubic Hermite interpolation (Fritsch-Carlson method).
// Shared helper: takes independent/dependent axis values, returns vec2(ind, dep).
// Guarantees monotonicity within each segment — no overshoot at local extrema.
// Matches D3's curveMonotoneX/Y behavior.
const MONOTONE_HELPER = /* wgsl */ `
fn monotoneInterp(
	ind0: f32, dep0: f32,
	ind1: f32, dep1: f32,
	ind2: f32, dep2: f32,
	ind3: f32, dep3: f32,
	t: f32
) -> vec2<f32> {
	// Segment widths along independent axis
	let h0 = ind1 - ind0;
	let h1 = ind2 - ind1;
	let h2 = ind3 - ind2;

	// Degenerate segment: fall back to linear
	if (abs(h1) < 0.001) {
		return vec2<f32>(mix(ind1, ind2, t), mix(dep1, dep2, t));
	}

	// Slopes (d_dep / d_ind) for each segment
	let s0 = select((dep1 - dep0) / h0, 0.0, abs(h0) < 0.001);
	let s1 = (dep2 - dep1) / h1;
	let s2 = select((dep3 - dep2) / h2, 0.0, abs(h2) < 0.001);

	// Monotone tangent at point 1
	var m1: f32;
	if (abs(h0) < 0.001) {
		// Series start (p0 clamped to p1): one-sided tangent
		m1 = s1;
	} else if (s0 * s1 <= 0.0) {
		// Local extremum: zero tangent prevents overshoot
		m1 = 0.0;
	} else {
		// Weighted harmonic mean (Fritsch-Carlson / D3)
		m1 = 3.0 * (h0 + h1) / ((h0 + 2.0 * h1) / s0 + (2.0 * h0 + h1) / s1);
	}

	// Monotone tangent at point 2
	var m2: f32;
	if (abs(h2) < 0.001) {
		// Series end (p3 clamped to p2): one-sided tangent
		m2 = s1;
	} else if (s1 * s2 <= 0.0) {
		// Local extremum: zero tangent
		m2 = 0.0;
	} else {
		m2 = 3.0 * (h1 + h2) / ((h1 + 2.0 * h2) / s1 + (2.0 * h1 + h2) / s2);
	}

	// Hermite basis functions
	let t2 = t * t;
	let t3 = t2 * t;
	let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
	let h10 = t3 - 2.0 * t2 + t;
	let h01 = -2.0 * t3 + 3.0 * t2;
	let h11 = t3 - t2;

	// Interpolate: tangent slopes scaled by segment width for Hermite basis
	let dep = h00 * dep1 + h10 * (m1 * h1) + h01 * dep2 + h11 * (m2 * h1);

	// Independent axis is linearly interpolated
	let ind = mix(ind1, ind2, t);

	return vec2<f32>(ind, dep);
}
`;

// Monotone-X: x is independent (linearly interpolated), y is monotone-constrained.
// Use for LineMark / AreaMarkY where x is the ordered dimension.
export const CURVE_MONOTONE_X = /* wgsl */ `
${MONOTONE_HELPER}
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	let r = monotoneInterp(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, t);
	return r;
}
`;

// Monotone-Y: y is independent (linearly interpolated), x is monotone-constrained.
// Use for AreaMarkX where y is the ordered dimension.
export const CURVE_MONOTONE_Y = /* wgsl */ `
${MONOTONE_HELPER}
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	let r = monotoneInterp(p0.y, p0.x, p1.y, p1.x, p2.y, p2.x, p3.y, p3.x, t);
	return vec2<f32>(r.y, r.x);
}
`;

// Bump curves: cubic Bezier with flat (zero) tangents at each data point.
// Creates S-shaped transitions between points. Good for bump charts, ordinal data.
// Ignores p0/p3 — only uses segment endpoints p1/p2.
// Matches D3's curveBumpX/Y behavior.
const BUMP_HELPER = /* wgsl */ `
fn bumpInterp(
	ind1: f32, dep1: f32,
	ind2: f32, dep2: f32,
	t: f32
) -> vec2<f32> {
	// Cubic Bezier with control points at (mid, dep1) and (mid, dep2)
	// where mid = midpoint of independent axis. This produces flat tangents.
	let mid = (ind1 + ind2) * 0.5;
	let u = 1.0 - t;
	// ind: u³·ind1 + 3ut·mid + t³·ind2 (Bezier with both interior CPs at mid)
	let ind = u * u * u * ind1 + 3.0 * u * t * mid + t * t * t * ind2;
	// dep: Hermite basis with zero tangents = u²(1+2t)·dep1 + t²(3-2t)·dep2
	let dep = u * u * (1.0 + 2.0 * t) * dep1 + t * t * (3.0 - 2.0 * t) * dep2;
	return vec2<f32>(ind, dep);
}
`;

// Bump-X: x is independent, y transitions with S-curve.
export const CURVE_BUMP_X = /* wgsl */ `
${BUMP_HELPER}
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	return bumpInterp(p1.x, p1.y, p2.x, p2.y, t);
}
`;

// Bump-Y: y is independent, x transitions with S-curve.
export const CURVE_BUMP_Y = /* wgsl */ `
${BUMP_HELPER}
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	let r = bumpInterp(p1.y, p1.x, p2.y, p2.x, t);
	return vec2<f32>(r.y, r.x);
}
`;

/**
 * Registry mapping curve type names to their WGSL implementations.
 */
export const CURVE_IMPLEMENTATIONS = {
	linear: CURVE_LINEAR,
	step: CURVE_STEP,
	'step-after': CURVE_STEP_AFTER,
	'step-before': CURVE_STEP_BEFORE,
	'catmull-rom': CURVE_CATMULL_ROM,
	'monotone-x': CURVE_MONOTONE_X,
	'monotone-y': CURVE_MONOTONE_Y,
	'bump-x': CURVE_BUMP_X,
	'bump-y': CURVE_BUMP_Y
};

/**
 * Configuration registry pairing each curve type with its WGSL code and
 * sub-segment resolution. Resolution determines how many quads are generated
 * per data interval to approximate the curve.
 *
 * - linear: 1 (identity — same as direct interpolation)
 * - step: 3 (horizontal + vertical + horizontal)
 * - step-after/step-before: 2 (horizontal + vertical segments)
 * - catmull-rom: max 128 (smooth cubic, adaptive per-segment)
 * - monotone-x/y: max 128 (smooth monotone cubic, adaptive per-segment)
 * - bump-x/y: max 128 (S-curve with flat tangents, adaptive per-segment)
 *
 * Smooth curves (resolution > 3) use adaptive sub-segment counts in the shader:
 * effectiveRes = clamp(ceil(chordPixelLen / 4.0), 1, CURVE_RESOLUTION).
 * Short segments use fewer sub-segments; long (zoomed-in) segments use more.
 */
export const CURVE_CONFIGS = {
	linear: { wgsl: CURVE_LINEAR, resolution: 1 },
	step: { wgsl: CURVE_STEP, resolution: 3 },
	'step-after': { wgsl: CURVE_STEP_AFTER, resolution: 2 },
	'step-before': { wgsl: CURVE_STEP_BEFORE, resolution: 2 },
	'catmull-rom': { wgsl: CURVE_CATMULL_ROM, resolution: 128 },
	'monotone-x': { wgsl: CURVE_MONOTONE_X, resolution: 128 },
	'monotone-y': { wgsl: CURVE_MONOTONE_Y, resolution: 128 },
	'bump-x': { wgsl: CURVE_BUMP_X, resolution: 128 },
	'bump-y': { wgsl: CURVE_BUMP_Y, resolution: 128 }
};

/** Get WGSL code for a curve type with CURVE_RESOLUTION constant prepended. */
export function getCurveWGSL(curveType) {
	const config = CURVE_CONFIGS[curveType] || CURVE_CONFIGS.linear;
	return `const CURVE_RESOLUTION: u32 = ${config.resolution}u;\n${config.wgsl}`;
}

/** Get the sub-segment resolution for a curve type. */
export function getCurveResolution(curveType) {
	return (CURVE_CONFIGS[curveType] || CURVE_CONFIGS.linear).resolution;
}
