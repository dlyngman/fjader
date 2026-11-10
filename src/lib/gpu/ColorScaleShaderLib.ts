import { isNanExpr } from './NanShaderLib';
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

/**
 * The ColorConfig layout, in the one file that declares it.
 *
 * The struct below is the definition; these are how JS addresses it. They live
 * here because a byte offset written anywhere else is a copy of a fact stated
 * in WGSL, with nothing to keep the two in step — the scale wrote the whole
 * struct from one set of literals and the coordinator patched `slotBase` from
 * another, each correct and neither able to notice the other drifting.
 */
export const COLOR_CONFIG_BYTES = 48;

/**
 * Where `slotBase` sits. Patched on its own when a scale's block moves in the
 * shared slot table, which is the one field written without rewriting the rest.
 */
export const COLOR_CONFIG_SLOT_BASE_OFFSET = 32;

/** `slotBase` meaning "this channel already carries a palette index". */
export const NO_SLOT_TABLE = 0xffffffff;

/**
 * The rank of a category an ordinal colour scale draws in the null colour: it
 * takes no palette slot, so it reads as missing data and shifts no category's
 * colour. The NULL category and the Other buckets. -1, by contrast, is a category
 * outside this scale's domain, which draws transparent.
 */
export const NULL_COLOR_RANK = -2;

/**
 * How many colour configs the buffer holds. A uniform array has a fixed length
 * in WGSL, so the shader declaration and the buffer size both read this.
 */
export const MAX_COLOR_SLOTS = 64;

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
    slotBase: u32,          // byte 32 — base into identitySlots, or NO_SLOT_TABLE
    _pad0: u32,             // byte 36
    _pad1: u32,             // byte 40
    _pad2: u32,             // byte 44
}

/**
 * slotBase when this scale's channel already carries a palette index rather
 * than an identity id. Distinct from base 0, which is a real block — the
 * permanently empty one — so it cannot be confused with "not placed".
 */
const NO_SLOT_TABLE: u32 = 0xFFFFFFFFu;

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

// colorConfigs is a UNIFORM, visible to the vertex stage as well: selection
// dimming reads a colour scale's slotBase per vertex. As storage it would take
// the last of the vertex stage's default 8 storage buffers on Rects, which uses
// 7 (six channels and the identity slot table); as a uniform it leaves that
// slot free. 64 × 48 bytes is 3 KB, written when a scale changes, which is what
// uniform buffers are for.
export const COLOR_SCALE_BINDINGS = /* wgsl */ `
@group(2) @binding(1) var<uniform> colorConfigs: array<ColorConfig, ${MAX_COLOR_SLOTS}>;
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

fn samplePalette(config: ColorConfig, categoryIndex: u32, nullColor: vec4<f32>) -> vec4<f32> {
    // The channel carries an identity id, which is stable and has nothing to do
    // with this scale's palette. Resolve it to this scale's own rank first; the
    // palette is indexed by rank, so the plotted categories take palette colours
    // in order and the wrap below is over the PLOTTED count, not the dim's.
    var idx = categoryIndex;
    if (config.slotBase != NO_SLOT_TABLE) {
        let slot = identitySlot(config.slotBase, categoryIndex);
        if (slot < 0.0) {
            // ${NULL_COLOR_RANK}: a category drawn in the null colour, which takes no
            // palette slot (the NULL category, an Other bucket).
            if (slot < -1.5) {
                return nullColor;
            }
            // -1: not ranked by this scale, a category outside its domain.
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        idx = u32(slot);
    }
    return ordinalPalettes[config.paletteOffset + (idx % config.paletteSize)];
}

fn getColorFromScale(scaleIndex: u32, value: f32, nullColor: vec4<f32>) -> vec4<f32> {
    let config = colorConfigs[scaleIndex];

    if (config.scaleType == COLOR_SCALE_ORDINAL) {
        // 0-based indexing: -1 = null, 0+ = valid categories
        if (value < 0.0) {
            return nullColor;
        }
        let catIdx = u32(value);
        return samplePalette(config, catIdx, nullColor);
    }

    if (${isNanExpr('value')}) {
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
    return samplePalette(config, categoryIndex, nullColor);
}

fn getContinuousColor(scaleIndex: u32, value: f32, nullColor: vec4<f32>) -> vec4<f32> {
    if (${isNanExpr('value')}) {
        return nullColor;
    }
    let config = colorConfigs[scaleIndex];
    if (config.transformType == COLOR_TRANSFORM_LOG && value <= 0.0) {
        return nullColor;
    }
    let t = normalizeValue(config, value);
    return sampleRamp(config, t);
}

/**
 * How selected this value's category is on an ordinal colour scale, 0..1.
 *
 * Read per vertex for selection dimming. 1.0 for anything that has no category
 * to select: a continuous scale, an ordinal scale whose channel does not carry
 * identity ids yet (NO_SLOT_TABLE), and a missing category. The -1 and NaN
 * checks come before the cast, because u32() of a negative or NaN float is
 * indeterminate in WGSL and would read an arbitrary activity.
 */
fn colorActivity(scaleIndex: u32, value: f32, group: u32) -> f32 {
    if (value < 0.0 || ${isNanExpr('value')}) {
        return 1.0;
    }
    let config = colorConfigs[scaleIndex];
    if (config.scaleType != COLOR_SCALE_ORDINAL || config.slotBase == NO_SLOT_TABLE) {
        return 1.0;
    }
    return identityActivity(config.slotBase, group, u32(value));
}

/** A mark's colour activity in its filter group: 1.0 unless it colours through a scale. */
fn markColorActivity(colorMode: u32, colorScaleIndex: u32, colorValue: f32, group: u32) -> f32 {
    if (colorMode != 1u) {
        return 1.0;
    }
    return colorActivity(colorScaleIndex, colorValue, group);
}
`;
