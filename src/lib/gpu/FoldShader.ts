import { isNanExpr } from './NanShaderLib';
import { RESOLVE_WORKGROUP } from './ResolveShader';
import {
	invertExpr,
	invertReference,
	normalizeExpr,
	normalizeReference,
	type FoldScaleKind
} from './ScaleNormalize';

/**
 * The fold kernel: a morphing channel's on-screen values, re-expressed in a
 * scale's new domain so they stay on the same pixels.
 *
 * `from[j] = invert(current, normalize(drawn, resolved[j]))`
 *
 * `resolved` is what the mark drew last frame, under the domain it was drawn
 * with (`drawn`). After an instant change of domain (`current`), the same
 * values would land elsewhere: a snap that halves the domain doubles every
 * bar. Written into `from`, the folded values draw exactly where the old ones
 * were, and the transition that follows carries each to its real value under
 * the new domain: the axis changes in one frame, the marks glide.
 *
 * Runs in place of the plain fold's copy (`resolved → from`), in the same
 * compute pass, before the resolve dispatches that read `from`.
 *
 * Both domains arrive as IMMEDIATES, packed as the draw passes pack them
 * (`#writeScaleParam`): they are scale params, the per-frame shared state
 * immediates are for. 48 bytes: `count` padded to 16, then two vec4.
 *
 * A NaN stays NaN (the resolve then takes `to`, as for any NaN). A degenerate
 * current domain (p3 = 0, zero width) cannot be inverted: the value is kept.
 */

/** Bytes of immediate data: `count` (padded to 16), `drawn`, `current`. */
export const FOLD_IMMEDIATE_SIZE = 48;

export function foldShader(kind: FoldScaleKind): string {
	return /* wgsl */ `
requires immediate_address_space;

struct ScaleParam {
  p1: f32,
  p2: f32,
  p3: f32,
  p4: f32,
};

struct Params {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  drawn: ScaleParam,
  current: ScaleParam,
};

@group(0) @binding(0) var<storage, read>       resolved:  array<f32>;
@group(0) @binding(1) var<storage, read_write> valueFrom: array<f32>;
var<immediate> params: Params;

@compute @workgroup_size(${RESOLVE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.count) {
    return;
  }
  let j = gid.x;
  let v = resolved[j];
  let drawn = params.drawn;
  let current = params.current;
  let folded = ${invertExpr(kind, normalizeExpr(kind, 'v', 'drawn'), 'current')};
  let keep = ${isNanExpr('v')} || current.p3 == 0.0;
  valueFrom[j] = select(folded, v, keep);
}
`;
}

/**
 * The same in JS: what the kernel computes, asserted against it the way
 * `resolveReference` is. Params as `[p1, p2, p3, p4]`.
 */
export function foldReference(
	kind: FoldScaleKind,
	resolved: ArrayLike<number>,
	drawn: ArrayLike<number>,
	current: ArrayLike<number>,
	out: Float32Array
): Float32Array {
	for (let j = 0; j < resolved.length; j++) {
		const v = resolved[j];
		out[j] =
			Number.isNaN(v) || current[2] === 0
				? v
				: invertReference(kind, normalizeReference(kind, v, drawn), current);
	}
	return out;
}

export interface FoldPipeline {
	pipeline: GPUComputePipeline;
	layout: GPUBindGroupLayout;
}

const PIPELINES = new WeakMap<GPUDevice, Map<FoldScaleKind, FoldPipeline>>();

/** One fold pipeline per device and scale kind, shared by every morphing mark. */
export function foldPipelineFor(device: GPUDevice, kind: FoldScaleKind): FoldPipeline {
	let byKind = PIPELINES.get(device);
	if (!byKind) {
		byKind = new Map();
		PIPELINES.set(device, byKind);
	}
	let entry = byKind.get(kind);
	if (!entry) {
		const stage = GPUShaderStage.COMPUTE;
		const label = `fold-${kind}`;
		const layout = device.createBindGroupLayout({
			label,
			entries: [
				{ binding: 0, visibility: stage, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: stage, buffer: { type: 'storage' } }
			]
		});
		const pipeline = device.createComputePipeline({
			label,
			layout: device.createPipelineLayout({
				label,
				bindGroupLayouts: [layout],
				immediateSize: FOLD_IMMEDIATE_SIZE
			}),
			compute: {
				module: device.createShaderModule({ label, code: foldShader(kind) }),
				entryPoint: 'main'
			}
		});
		entry = { pipeline, layout };
		byKind.set(kind, entry);
	}
	return entry;
}
