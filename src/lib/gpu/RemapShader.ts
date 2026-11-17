import { RESOLVE_WORKGROUP } from './ResolveShader';
import { REMAP_HEADER_WORDS } from './bin-remap';
import {
	invertExpr,
	invertReference,
	normalizeExpr,
	normalizeReference,
	type FoldScaleKind
} from './ScaleNormalize';

/**
 * The remap kernel: a rebin's new bars start where the old bars they cover
 * were drawn.
 *
 *   from[j] = Σ_k weight[k] · old[row_k] + uncovered[b] · T⁻¹(to[j])
 *
 * `old` is the channel's resolved buffer as last drawn, in the OLD row layout;
 * `row_k` is new row j's counterpart in old bin k (the same facet and series,
 * `bin-remap.ts`). The result is in the units the old rows were drawn in
 * (`drawn`): the channel's pixel-space resolve then carries it from those
 * pixels to `to` under the scale as it moves (ResolveShader). So only the
 * uncovered part, which starts at its own new value, is re-expressed in those
 * units: `T⁻¹(v) = invert(drawn, normalize(current, v))`. A binding on no
 * scale (an Other share) takes no transform: kind 'none'.
 *
 * Runs once per rebin per channel, in place of the snap's copy, before the
 * resolve dispatches. Immediates: `count` padded to 16, then the drawn and
 * current params (48 B).
 *
 * A NaN among the old values makes the sum NaN, and the resolve then takes
 * `to` for that row: it lands, as any NaN does. An uncovered share of 0 adds
 * nothing, even for a NaN `to`.
 */

export type RemapKind = FoldScaleKind | 'none';

export const REMAP_IMMEDIATE_SIZE = 48;

/** `to` re-expressed in the units of `drawn`: T⁻¹. */
function intoDrawnExpr(kind: RemapKind, v: string): string {
	if (kind === 'none') return v;
	return `select(${invertExpr(kind, normalizeExpr(kind, v, 'current'), 'drawn')}, ${v}, drawn.p3 == 0.0)`;
}

export function remapShader(kind: RemapKind): string {
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

@group(0) @binding(0) var<storage, read>       old:       array<f32>;
@group(0) @binding(1) var<storage, read>       valueTo:   array<f32>;
@group(0) @binding(2) var<storage, read_write> valueFrom: array<f32>;
@group(0) @binding(3) var<storage, read>       map:       array<u32>;
var<immediate> params: Params;

@compute @workgroup_size(${RESOLVE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let j = gid.x;
  if (j >= params.count) {
    return;
  }
  let newBins = map[0];
  let oldBins = map[1];
  let series = map[2];
  let overlaps = map[4];
  let s = j % series;
  let b = (j / series) % newBins;
  let f = j / (series * newBins);
  let offsetsAt = ${REMAP_HEADER_WORDS}u;
  let oldBinAt = offsetsAt + newBins + 1u;
  let weightAt = oldBinAt + overlaps;
  let uncoveredAt = weightAt + overlaps;
  let drawn = params.drawn;
  let current = params.current;

  var sum = 0.0;
  for (var k = map[offsetsAt + b]; k < map[offsetsAt + b + 1u]; k++) {
    let row = (f * oldBins + map[oldBinAt + k]) * series + s;
    sum += bitcast<f32>(map[weightAt + k]) * old[row];
  }
  let uncovered = bitcast<f32>(map[uncoveredAt + b]);
  if (uncovered > 0.0) {
    let v = valueTo[j];
    sum += uncovered * ${intoDrawnExpr(kind, 'v')};
  }
  valueFrom[j] = sum;
}
`;
}

/** The same in JS, asserted against the kernel's intent. Params as `[p1, p2, p3, p4]`. */
export function remapReference(
	kind: RemapKind,
	old: ArrayLike<number>,
	to: ArrayLike<number>,
	map: Uint32Array,
	drawn: ArrayLike<number>,
	current: ArrayLike<number>,
	count: number,
	out: Float32Array
): Float32Array {
	const newBins = map[0];
	const oldBins = map[1];
	const series = map[2];
	const K = map[4];
	const offsetsAt = REMAP_HEADER_WORDS;
	const oldBinAt = offsetsAt + newBins + 1;
	const floats = new Float32Array(map.buffer, map.byteOffset, map.length);
	const weightAt = oldBinAt + K;
	const uncoveredAt = weightAt + K;
	const intoDrawn = (v: number) =>
		kind === 'none' || drawn[2] === 0
			? v
			: invertReference(kind, normalizeReference(kind, v, current), drawn);
	for (let j = 0; j < count; j++) {
		const s = j % series;
		const b = Math.floor(j / series) % newBins;
		const f = Math.floor(j / (series * newBins));
		let sum = 0;
		for (let k = map[offsetsAt + b]; k < map[offsetsAt + b + 1]; k++) {
			const row = (f * oldBins + map[oldBinAt + k]) * series + s;
			sum += floats[weightAt + k] * old[row];
		}
		const u = floats[uncoveredAt + b];
		if (u > 0) sum += u * intoDrawn(to[j]);
		out[j] = sum;
	}
	return out;
}

export interface RemapPipeline {
	pipeline: GPUComputePipeline;
	layout: GPUBindGroupLayout;
}

const PIPELINES = new WeakMap<GPUDevice, Map<RemapKind, RemapPipeline>>();

/** One remap pipeline per device and kind, shared by every morphing mark. */
export function remapPipelineFor(device: GPUDevice, kind: RemapKind): RemapPipeline {
	let byKind = PIPELINES.get(device);
	if (!byKind) {
		byKind = new Map();
		PIPELINES.set(device, byKind);
	}
	let entry = byKind.get(kind);
	if (!entry) {
		const stage = GPUShaderStage.COMPUTE;
		const label = `remap-${kind}`;
		const layout = device.createBindGroupLayout({
			label,
			entries: [
				{ binding: 0, visibility: stage, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: stage, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: stage, buffer: { type: 'storage' } },
				{ binding: 3, visibility: stage, buffer: { type: 'read-only-storage' } }
			]
		});
		const pipeline = device.createComputePipeline({
			label,
			layout: device.createPipelineLayout({
				label,
				bindGroupLayouts: [layout],
				immediateSize: REMAP_IMMEDIATE_SIZE
			}),
			compute: {
				module: device.createShaderModule({ label, code: remapShader(kind) }),
				entryPoint: 'main'
			}
		});
		entry = { pipeline, layout };
		byKind.set(kind, entry);
	}
	return entry;
}

/**
 * The gather kernel: a merge's held rows take their parent's new value, so
 * they travel there in the layout already drawn (BaseGPURenderer's hold).
 *
 *   to[j] = Σ_k weight[k] · src[row_k] + uncovered[b] · to[j]
 *
 * `src` is the new result's rows, in the NEW layout; `to` is the held
 * layout's. The map runs from new bins onto held ones (`buildBinRemap(new,
 * held)`): nested, so each held bin has one parent at weight 1, or none (in
 * the window's margin), when it keeps the `to` it had. Reading its own slot
 * is safe: each invocation writes only its own. No transform: the new values
 * are in the target's units, which is what `to` holds while riding.
 *
 * Runs once per write during a hold, per channel, after the fold and before
 * the resolve. Immediates: `count` padded to 16.
 */
export const GATHER_IMMEDIATE_SIZE = 16;

export function gatherShader(): string {
	return /* wgsl */ `
requires immediate_address_space;

struct Params {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<storage, read>       src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read>       map: array<u32>;
var<immediate> params: Params;

@compute @workgroup_size(${RESOLVE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let j = gid.x;
  if (j >= params.count) {
    return;
  }
  let dstBins = map[0];
  let srcBins = map[1];
  let series = map[2];
  let overlaps = map[4];
  let s = j % series;
  let b = (j / series) % dstBins;
  let f = j / (series * dstBins);
  let offsetsAt = ${REMAP_HEADER_WORDS}u;
  let srcBinAt = offsetsAt + dstBins + 1u;
  let weightAt = srcBinAt + overlaps;
  let uncoveredAt = weightAt + overlaps;

  var sum = 0.0;
  for (var k = map[offsetsAt + b]; k < map[offsetsAt + b + 1u]; k++) {
    let row = (f * srcBins + map[srcBinAt + k]) * series + s;
    sum += bitcast<f32>(map[weightAt + k]) * src[row];
  }
  let uncovered = bitcast<f32>(map[uncoveredAt + b]);
  if (uncovered > 0.0) {
    sum += uncovered * dst[j];
  }
  dst[j] = sum;
}
`;
}

/** The same in JS, asserted against the kernel's intent. Writes `dst` in place. */
export function gatherReference(
	src: ArrayLike<number>,
	dst: Float32Array,
	map: Uint32Array,
	count: number
): Float32Array {
	const dstBins = map[0];
	const srcBins = map[1];
	const series = map[2];
	const K = map[4];
	const offsetsAt = REMAP_HEADER_WORDS;
	const srcBinAt = offsetsAt + dstBins + 1;
	const floats = new Float32Array(map.buffer, map.byteOffset, map.length);
	const weightAt = srcBinAt + K;
	const uncoveredAt = weightAt + K;
	for (let j = 0; j < count; j++) {
		const s = j % series;
		const b = Math.floor(j / series) % dstBins;
		const f = Math.floor(j / (series * dstBins));
		let sum = 0;
		for (let k = map[offsetsAt + b]; k < map[offsetsAt + b + 1]; k++) {
			sum += floats[weightAt + k] * src[(f * srcBins + map[srcBinAt + k]) * series + s];
		}
		const u = floats[uncoveredAt + b];
		if (u > 0) sum += u * dst[j];
		dst[j] = sum;
	}
	return dst;
}

const GATHER_PIPELINES = new WeakMap<GPUDevice, RemapPipeline>();

/** One gather pipeline per device, shared by every holding mark. */
export function gatherPipelineFor(device: GPUDevice): RemapPipeline {
	let entry = GATHER_PIPELINES.get(device);
	if (!entry) {
		const stage = GPUShaderStage.COMPUTE;
		const label = 'gather';
		const layout = device.createBindGroupLayout({
			label,
			entries: [
				{ binding: 0, visibility: stage, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: stage, buffer: { type: 'storage' } },
				{ binding: 2, visibility: stage, buffer: { type: 'read-only-storage' } }
			]
		});
		const pipeline = device.createComputePipeline({
			label,
			layout: device.createPipelineLayout({
				label,
				bindGroupLayouts: [layout],
				immediateSize: GATHER_IMMEDIATE_SIZE
			}),
			compute: {
				module: device.createShaderModule({ label, code: gatherShader() }),
				entryPoint: 'main'
			}
		});
		entry = { pipeline, layout };
		GATHER_PIPELINES.set(device, entry);
	}
	return entry;
}
