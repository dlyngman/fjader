// src/lib/gpu/ColorScaleShaderLib.ts

// ---------------------------------------------------------------------------
// Design note: branching vs JIT-compiled shaders for color normalization
//
// Position scales (x/y) use JIT-compiled shader templates via ScaleTemplateSystem
// because the function bodies differ significantly per type (band is a full
// category lookup, symlog has a helper function, etc.) and they sit on the
// hottest path of every vertex.
//
// Color normalization is different: the transform is a single expression inside
// a small normalizeValue() function, the ramp sampling and palette lookup are
// identical for all types, and — critically — all vertices in a draw call share
// the same color config, so the branch is *uniform* (no wavefront divergence).
// A switch on a uniform u32 is essentially free on modern GPUs.
//
// JIT for color would couple the transform type into the pipeline cache key,
// multiplying pipeline variants with no measurable benefit. If this ever
// becomes a bottleneck, we can JIT-compile normalizeValue per config; for now,
// runtime branching is the right trade-off.
// ---------------------------------------------------------------------------

export const COLOR_SCALE_STRUCTS = /* wgsl */ `
struct ColorConfig {
    domainMin: f32,         // byte 0  — pre-transformed for non-linear types
    domainMax: f32,         // byte 4  — pre-transformed for non-linear types
    rampOffset: u32,        // byte 8
    paletteOffset: u32,     // byte 12
    paletteSize: u32,       // byte 16
    scaleType: u32,         // byte 20 — scheme rendering type (ordinal/sequential/diverging/cyclical)
    transformType: u32,     // byte 24 — normalization transform (linear/log/symlog/sqrt/pow)
    transformParam: f32,    // byte 28 — symlog constant C, or pow exponent
}

const COLOR_SCALE_ORDINAL: u32 = 0u;
const COLOR_SCALE_SEQUENTIAL: u32 = 1u;
const COLOR_SCALE_DIVERGING: u32 = 2u;
const COLOR_SCALE_CYCLICAL: u32 = 3u;

const COLOR_TRANSFORM_LINEAR: u32 = 0u;
const COLOR_TRANSFORM_LOG: u32 = 1u;
const COLOR_TRANSFORM_SYMLOG: u32 = 2u;
const COLOR_TRANSFORM_SQRT: u32 = 3u;
const COLOR_TRANSFORM_POW: u32 = 4u;
`;

export const COLOR_SCALE_BINDINGS = /* wgsl */ `
@group(2) @binding(1) var<storage, read> colorConfigs: array<ColorConfig>;
@group(2) @binding(2) var<storage, read> colorRamps: array<vec4<f32>>;
@group(2) @binding(3) var<storage, read> ordinalPalettes: array<vec4<f32>>;
`;

export const COLOR_SCALE_FUNCTIONS = /* wgsl */ `
fn applyColorTransform(config: ColorConfig, value: f32) -> f32 {
    switch config.transformType {
        case COLOR_TRANSFORM_LOG: {
            return log(max(value, 1e-38));
        }
        case COLOR_TRANSFORM_SYMLOG: {
            let c = config.transformParam;
            return sign(value) * log(1.0 + abs(value / c));
        }
        case COLOR_TRANSFORM_SQRT: {
            return sign(value) * sqrt(abs(value));
        }
        case COLOR_TRANSFORM_POW: {
            return sign(value) * pow(abs(value), config.transformParam);
        }
        default: {
            return value;
        }
    }
}

fn normalizeValue(config: ColorConfig, value: f32) -> f32 {
    let transformed = applyColorTransform(config, value);

    let range = config.domainMax - config.domainMin;

    if (abs(range) < 0.0001) {
        return 0.5;
    }

    let t_raw = (transformed - config.domainMin) / range;

    if (config.scaleType == COLOR_SCALE_CYCLICAL) {
        return fract(t_raw);
    }

    return clamp(t_raw, 0.0, 1.0);
}

fn sampleRamp(config: ColorConfig, t: f32) -> vec4<f32> {
    let idx = min(u32(t * 255.0), 255u); // Must match COLOR_RAMP_RESOLUTION (256 stops)
    return colorRamps[config.rampOffset + idx];
}

fn samplePalette(config: ColorConfig, categoryIndex: u32) -> vec4<f32> {
    // 0-based indexing: category 0 maps to palette index 0
    let idx = categoryIndex % config.paletteSize;
    return ordinalPalettes[config.paletteOffset + idx];
}

fn getColorFromScale(scaleIndex: u32, value: f32, nullColor: vec4<f32>) -> vec4<f32> {
    let config = colorConfigs[scaleIndex];

    if (config.scaleType == COLOR_SCALE_ORDINAL) {
        // 0-based indexing: -1 = null, 0+ = valid categories
        if (value < 0.0) {
            return nullColor;
        }
        let catIdx = u32(value);
        return samplePalette(config, catIdx);
    }

    if (value != value) {
        return nullColor;
    }

    // Log requires strictly positive values — treat ≤0 as unmappable
    if (config.transformType == COLOR_TRANSFORM_LOG && value <= 0.0) {
        return nullColor;
    }

    let t = normalizeValue(config, value);
    return sampleRamp(config, t);
}

fn getOrdinalColor(scaleIndex: u32, categoryIndex: u32, nullColor: vec4<f32>) -> vec4<f32> {
    // Note: This function expects u32, so caller must handle -1 check before casting
    let config = colorConfigs[scaleIndex];
    return samplePalette(config, categoryIndex);
}

fn getContinuousColor(scaleIndex: u32, value: f32, nullColor: vec4<f32>) -> vec4<f32> {
    if (value != value) {
        return nullColor;
    }
    let config = colorConfigs[scaleIndex];
    if (config.transformType == COLOR_TRANSFORM_LOG && value <= 0.0) {
        return nullColor;
    }
    let t = normalizeValue(config, value);
    return sampleRamp(config, t);
}
`;
