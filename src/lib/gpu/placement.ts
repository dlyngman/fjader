/**
 * Placement: a renderer's kernels that write each drawn row's resolved geometry
 * and appearance into a RECORD, once per frame its chart draws.
 *
 * Inputs (the renderer's per-row channels, morph-resolved while morphing) are
 * read by the kernels only. The draw reads the record and expands corners; so
 * does anything attached to the mark (labels, culling, picking). One copy of
 * the placement code places both the mark and what attaches to it, and each
 * consumer binds one buffer instead of the mark's inputs.
 *
 * The kernels are compiled through the same scale templates as the
 * renderer's draw (GPUCoordinator.acquireComputePipeline), read the chart's
 * immediates, frame uniforms and scale resources at the same group numbers as
 * the draw, and run in the frame's one placement pass, after the slot and
 * morph resolves (GPUCoordinator.registerPlacement).
 *
 * A renderer declares a LIST of kernels, each writing named record fields:
 * fused where one fits the default 8 storage buffers per stage, split where
 * it does not. Consumers only ever see the record.
 */

/** Threads per workgroup for every placement kernel: `@workgroup_size(64)`. */
export const PLACEMENT_WORKGROUP = 64;

/** Where a kernel's group-1 binding gets its buffer, looked up at each dispatch. */
export type PlacementBinding =
	/** A per-row channel: the morph's resolved buffer while one runs, else the uploaded one. */
	| { binding: number; source: 'channel'; channel: number }
	/**
	 * A vertex slot's buffer (seams, facet index); a zero-filled stand-in when
	 * absent. With `rowBytes`, also the stand-in when the buffer does not cover
	 * every drawn row: all of the slot's values or none, never the first rows
	 * of a layout over rows of another (a rebin's seams, against a drawn count
	 * they were not written for).
	 */
	| { binding: number; source: 'vertex'; slot: number; rowBytes?: number }
	/** A uniform the renderer writes (its mark constants). */
	| { binding: number; source: 'uniform'; channel: number }
	/** The record, written by the kernel. */
	| { binding: number; source: 'record' };

export interface PlacementKernel {
	/** Names the kernel's pipeline: `${markType}-place-${name}`. */
	name: string;
	/**
	 * WGSL with the renderer's placeholders (`{{X_AXIS_LOGIC}}`, …), declaring
	 * its group-1 bindings, entry point `placeMain` at `@workgroup_size(64)`. It
	 * covers `chartScales.rows.x` rows from `chartScales.rows.y`.
	 */
	code: string;
	bindings: PlacementBinding[];
}

export interface PlacementConfig {
	kernels: PlacementKernel[];
	/** The record's binding in the draw's group 1. */
	recordBinding: number;
	/** Bytes per row of the record. */
	recordStride: number;
}

/** A kernel binding's group-1 layout entry. */
export function placementLayoutEntry(b: PlacementBinding): {
	binding: number;
	visibility: number;
	type: string;
} {
	const type =
		b.source === 'record' ? 'storage' : b.source === 'uniform' ? 'uniform' : 'read-only-storage';
	return { binding: b.binding, visibility: GPUShaderStage.COMPUTE, type };
}
