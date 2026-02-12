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

// Step: midpoint step. Horizontal at p1.y until midpoint, then p2.y. Ignores p0/p3.
export const CURVE_STEP = /* wgsl */ `
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	let midX = mix(p1.x, p2.x, 0.5);
	if (t < 0.5) {
		return vec2<f32>(mix(p1.x, midX, t * 2.0), p1.y);
	} else {
		return vec2<f32>(mix(midX, p2.x, (t - 0.5) * 2.0), p2.y);
	}
}
`;

// Catmull-Rom spline: cubic interpolation using all 4 control points.
// Uses the standard Catmull-Rom matrix with alpha = 0.5 (centripetal).
export const CURVE_CATMULL_ROM = /* wgsl */ `
fn evaluateCurve(
	p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>,
	t: f32
) -> vec2<f32> {
	let t2 = t * t;
	let t3 = t2 * t;
	// Catmull-Rom basis matrix (tension = 0.5)
	let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
	let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
	let c = -0.5 * p0 + 0.5 * p2;
	let d = p1;
	return a * t3 + b * t2 + c * t + d;
}
`;

/**
 * Registry mapping curve type names to their WGSL implementations.
 * Used by ScaleTemplateSystem (Phase 2) for compile-time curve selection.
 */
export const CURVE_IMPLEMENTATIONS = {
	linear: CURVE_LINEAR,
	step: CURVE_STEP,
	'step-after': CURVE_STEP_AFTER,
	'step-before': CURVE_STEP_BEFORE,
	'catmull-rom': CURVE_CATMULL_ROM
};
