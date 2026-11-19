/**
 * A chart's text atlas, as every shader sees it: three bindings in the chart's
 * frame bind group (@group(0)), next to the frame uniforms.
 *
 * Chart level, not mark level, because there is one atlas per chart and every
 * text layer in it reads the same one. It also keeps the atlas out of the
 * marks' storage-buffer budget: the entry table is a UNIFORM array (Rects
 * already uses 7 of the default 8 storage buffers per stage), and a texture
 * and a sampler count against limits of their own.
 *
 * A chart without text binds stand-ins (a 1×1 texture and a zeroed table), so
 * one layout serves every pipeline.
 */

export const ATLAS_TEXTURE_BINDING = 1;
export const ATLAS_SAMPLER_BINDING = 2;
export const ATLAS_ENTRIES_BINDING = 3;

/**
 * Entries per chart: one per distinct string and style. The table is one
 * vec4<f32> per entry and must fit a uniform binding, whose default limit is
 * 64 KiB: 4096 × 16 bytes exactly.
 */
export const ATLAS_MAX_ENTRIES = 4096;
export const ATLAS_ENTRY_BYTES = 16;
export const ATLAS_TABLE_BYTES = ATLAS_MAX_ENTRIES * ATLAS_ENTRY_BYTES;

export const ATLAS_FORMAT: GPUTextureFormat = 'rgba8unorm';

/**
 * The WGSL declarations, for a shader that reads the atlas. An entry is the
 * string's rectangle in the atlas texture, in texels: (x, y, width, height).
 * The atlas is rasterized at the canvas's device pixel ratio, so a texel is a
 * device pixel and the width and height are the string's size on screen.
 * A width of 0 means not rasterized yet (or released): draw nothing.
 */
export const ATLAS_WGSL = /* wgsl */ `
@group(0) @binding(${ATLAS_TEXTURE_BINDING}) var textAtlas: texture_2d<f32>;
@group(0) @binding(${ATLAS_SAMPLER_BINDING}) var textAtlasSampler: sampler;
struct TextAtlasEntries { rects: array<vec4<f32>, ${ATLAS_MAX_ENTRIES}> };
@group(0) @binding(${ATLAS_ENTRIES_BINDING}) var<uniform> textAtlasEntries: TextAtlasEntries;

// The coverage of the string in atlas rectangle rect at texel p (atlas
// texels), and 0 outside its rectangle, so a neighbour's texels never count.
// A load, not a sample: exact texels, in any control flow.
fn atlasCoverageAt(rect: vec4<f32>, p: vec2<f32>) -> f32 {
  let q = floor(p);
  if (any(q < rect.xy) || any(q >= rect.xy + rect.zw)) { return 0.0; }
  return textureLoad(textAtlas, vec2<i32>(q), 0).a;
}

// A string's halo at texel p: the most coverage within radius texels, on two
// rings of eight directions (half the radius and all of it, so a one-texel
// stroke between them is not missed). Drawn under the string in the
// background colour, it keeps text readable over lines. Its quad must reach
// radius texels past the string.
fn atlasHaloAt(rect: vec4<f32>, p: vec2<f32>, radius: f32) -> f32 {
  var m = atlasCoverageAt(rect, p);
  for (var ring = 1u; ring <= 2u; ring++) {
    let r = radius * f32(ring) * 0.5;
    let d = r * 0.7071;
    m = max(m, atlasCoverageAt(rect, p + vec2<f32>(r, 0.0)));
    m = max(m, atlasCoverageAt(rect, p + vec2<f32>(-r, 0.0)));
    m = max(m, atlasCoverageAt(rect, p + vec2<f32>(0.0, r)));
    m = max(m, atlasCoverageAt(rect, p + vec2<f32>(0.0, -r)));
    m = max(m, atlasCoverageAt(rect, p + vec2<f32>(d, d)));
    m = max(m, atlasCoverageAt(rect, p + vec2<f32>(-d, d)));
    m = max(m, atlasCoverageAt(rect, p + vec2<f32>(d, -d)));
    m = max(m, atlasCoverageAt(rect, p + vec2<f32>(-d, -d)));
  }
  return m;
}
`;

/** What the coordinator binds for a chart's atlas. */
export interface AtlasBinding {
	view: GPUTextureView;
	entries: GPUBuffer;
}
