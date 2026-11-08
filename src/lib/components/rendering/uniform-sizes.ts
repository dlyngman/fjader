/**
 * The byte size of every renderer's uniform struct, as WGSL lays it out.
 *
 * Renderers allocate their uniform buffers from these, and BaseGPURenderer
 * sizes its stand-in from the largest: a binding not yet written is bound to
 * the stand-in, and WebGPU rejects a draw whose uniform buffer is smaller than
 * the struct it declares, which loses every chart's frame in that submit. A
 * comment saying "must fit the largest struct" went stale the first time a
 * struct grew, so uniform-sizes.test.ts derives each size from the shader
 * source and fails when one drifts.
 */

/** Axes a parallel coordinates chart can hold: its axis arrays are sized for it. */
export const PARALLEL_MAX_AXES = 16;

/** One ScaleParam: four f32. */
const SCALE_PARAM_BYTES = 16;

export const UNIFORM_BYTES = {
	dotsMarkConstants: 48,
	rectsMarkConstants: 48,
	ruleXMarkConstants: 48,
	ruleYMarkConstants: 48,
	linesMarkConstants: 48,
	areasMarkConstants: 64,
	gridLineRuleConstants: 32,
	parallelConfig: 176,
	parallelAxisScales: PARALLEL_MAX_AXES * SCALE_PARAM_BYTES
} as const;

/** The stand-in uniform buffer: as large as the largest struct any renderer binds. */
export const UNIFORM_STAND_IN_BYTES = Math.max(...Object.values(UNIFORM_BYTES));
