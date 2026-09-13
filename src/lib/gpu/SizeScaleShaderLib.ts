// src/lib/gpu/SizeScaleShaderLib.js

export const SIZE_SCALE_STRUCTS = /* wgsl */ `
struct SizeConfig {
    domainMin: f32,
    domainMax: f32,
    rangeMin: f32,
    rangeMax: f32,
}
`;

/**
 * Size scale slots, and the single source of truth for how many.
 *
 * A uniform array must be declared at a constant length, so this number has to
 * reach the WGSL as well as the buffer allocation. It is exported and
 * interpolated rather than written twice: a mismatch is a pipeline-creation
 * validation error naming the binding, which is loud, but a constant that
 * exists in two files is a constant that eventually disagrees with itself.
 */
export const MAX_SIZE_SLOTS = 64;

/**
 * UNIFORM, not storage, and it always should have been.
 *
 * SizeConfig is four f32s — exactly the 16-byte stride the uniform address
 * space requires for array elements, so nothing is repacked — the whole array
 * is MAX_SIZE_SLOTS × 16 = 1 KB against a 64 KB default binding size, it is
 * read only by the vertex stage, and it is written when a size scale's domain
 * changes rather than per frame. Every property that makes a uniform buffer the
 * right container was already true of it.
 *
 * What it buys: the vertex stage sits at the default
 * maxStorageBuffersPerShaderStage of 8 (six mark channels, scale params, and
 * this), and animating a value channel needs a `from` and a `to` where there is
 * now one buffer. Uniform buffers are nowhere near their own default of 12. See
 * review_band_category_index_architecture.md §36.7.
 *
 * Dynamic indexing — `sizeConfigs[scaleIndex]` — is permitted on uniform arrays
 * in WGSL, and the shared slot table already relies on the same thing.
 */
export const SIZE_SCALE_BINDINGS = /* wgsl */ `
@group(2) @binding(4) var<uniform> sizeConfigs: array<SizeConfig, ${MAX_SIZE_SLOTS}>;
`;

export const SIZE_SCALE_FUNCTIONS = /* wgsl */ `
fn getSizeFromScale(scaleIndex: u32, value: f32) -> f32 {
    let config = sizeConfigs[scaleIndex];

    // Handle NaN → rangeMin
    if (value != value) {
        return config.rangeMin;
    }

    let range = config.domainMax - config.domainMin;

    // Degenerate domain → midpoint of range
    if (abs(range) < 0.0001) {
        return (config.rangeMin + config.rangeMax) * 0.5;
    }

    // Normalize to [0, 1]
    let t = clamp((value - config.domainMin) / range, 0.0, 1.0);

    // Sqrt for area-proportional scaling
    let s = sqrt(t);

    // Interpolate to pixel range
    return config.rangeMin + s * (config.rangeMax - config.rangeMin);
}
`;
