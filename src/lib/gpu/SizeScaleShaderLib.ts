// src/lib/gpu/SizeScaleShaderLib.js

export const SIZE_SCALE_STRUCTS = /* wgsl */ `
struct SizeConfig {
    domainMin: f32,
    domainMax: f32,
    rangeMin: f32,
    rangeMax: f32,
}
`;

export const SIZE_SCALE_BINDINGS = /* wgsl */ `
@group(2) @binding(4) var<storage, read> sizeConfigs: array<SizeConfig>;
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
