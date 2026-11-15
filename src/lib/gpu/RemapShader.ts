import { RESOLVE_WORKGROUP } from './ResolveShader';
import { REMAP_HEADER_WORDS } from './bin-remap';
import { FOLD_IMMEDIATE_SIZE } from './FoldShader';
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
 *   from[j] = Σ_k weight[k] · T(old[row_k]) + uncovered[b] · to[j]
 *
 * `old` is the channel's resolved buffer as last drawn, in the OLD row layout;
 * `row_k` is new row j's counterpart in old bin k (the same facet and series,
 * `bin-remap.ts`). `T` re-expresses a value drawn under the old domain in the
 * current one (FoldShader's transform), so the blend starts on the old pixels
 * even when the rebin also snapped the axis. A binding on no scale (an Other
 * share) takes the identity: kind 'none'.
 *
 * Runs once per rebin per channel, in place of the snap's copy, before the
 * resolve dispatches. Immediates as the fold's: `count` padded to 16, the
 * drawn and current params (48 B).
 *
 * A NaN among the old values makes the sum NaN, and the resolve then takes
 * `to` for that row: it lands, as any NaN does. An uncovered share of 0 adds
 * nothing, even for a NaN `to`.
 */

export type RemapKind = FoldScaleKind | 'none';

export const REMAP_IMMEDIATE_SIZE = FOLD_IMMEDIATE_SIZE;

function transformExpr(kind: RemapKind, v: string): string {
	if (kind === 'none') return v;
	return `select(${invertExpr(kind, normalizeExpr(kind, v, 'drawn'), 'current')}, ${v}, current.p3 == 0.0)`;
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
    let v = old[row];
    sum += bitcast<f32>(map[weightAt + k]) * ${transformExpr(kind, 'v')};
  }
  let uncovered = bitcast<f32>(map[uncoveredAt + b]);
  if (uncovered > 0.0) {
    sum += uncovered * valueTo[j];
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
	const T = (v: number) =>
		kind === 'none' || current[2] === 0
			? v
			: invertReference(kind, normalizeReference(kind, v, drawn), current);
	for (let j = 0; j < count; j++) {
		const s = j % series;
		const b = Math.floor(j / series) % newBins;
		const f = Math.floor(j / (series * newBins));
		let sum = 0;
		for (let k = map[offsetsAt + b]; k < map[offsetsAt + b + 1]; k++) {
			const row = (f * oldBins + map[oldBinAt + k]) * series + s;
			sum += floats[weightAt + k] * T(old[row]);
		}
		const u = floats[uncoveredAt + b];
		if (u > 0) sum += u * to[j];
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
