// src/lib/gpu/ColorScaleShaderLib.js

export const COLOR_SCALE_STRUCTS = /* wgsl */ `
struct ColorConfig {
    domainMin: f32,
    domainMax: f32,
    rampOffset: u32,
    paletteOffset: u32,
    paletteSize: u32,
    scaleType: u32,
    _pad0: u32,
    _pad1: u32,
}

const COLOR_SCALE_ORDINAL: u32 = 0u;
const COLOR_SCALE_SEQUENTIAL: u32 = 1u;
const COLOR_SCALE_DIVERGING: u32 = 2u;
const COLOR_SCALE_CYCLICAL: u32 = 3u;
`;

export const COLOR_SCALE_BINDINGS = /* wgsl */ `
@group(2) @binding(1) var<storage, read> colorConfigs: array<ColorConfig>;
@group(2) @binding(2) var<storage, read> colorRamps: array<vec4<f32>>;
@group(2) @binding(3) var<storage, read> ordinalPalettes: array<vec4<f32>>;
`;

export const COLOR_SCALE_FUNCTIONS = /* wgsl */ `
fn normalizeValue(config: ColorConfig, value: f32) -> f32 {
    let range = config.domainMax - config.domainMin;

    if (abs(range) < 0.0001) {
        return 0.5;
    }

    let t_raw = (value - config.domainMin) / range;

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
    let t = normalizeValue(config, value);
    return sampleRamp(config, t);
}
`;
