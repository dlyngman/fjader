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
`;

/** What the coordinator binds for a chart's atlas. */
export interface AtlasBinding {
	view: GPUTextureView;
	entries: GPUBuffer;
}
