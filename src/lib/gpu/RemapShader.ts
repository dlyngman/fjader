import { RESOLVE_WORKGROUP } from './ResolveShader';
import { REMAP_HEADER_WORDS } from './bin-remap';
import { getCurveWGSL } from './CurveShaderLib';
import type { CurveType } from '$lib/types';
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

/**
 * The curve a path's rows are drawn with, for a kernel that samples it: a
 * point map's entry of two old points (`k` and `k + 1`, weights `1 − t` and
 * `t`) is then evaluated on that curve at `t`, from the four points around the
 * segment, as the path shader draws it (CurveShaderLib's evaluateCurve), not
 * on the chord. So a new point starts on the drawn curve, not inside it.
 * `swap`: the path runs along y (AreaMarkX), its points are (value, centre).
 * Null: the weights as they are (bars, and linear paths, where the chord is
 * the curve).
 */
export interface RemapCurve {
	curve: CurveType;
	swap: boolean;
}

/**
 * The WGSL that samples a curve: `curveSample(…)` returns the value at `t` on
 * the segment from point `k` to `k + 1` of the sampled side, its neighbours
 * clamped at the series' ends as the path shader clamps them (pathPrev,
 * pathAfter). NaN anywhere among the four makes it NaN, as a drawn segment by
 * a gap breaks.
 */
function curveSampleWGSL(curve: RemapCurve): string {
	const point = curve.swap ? 'vec2<f32>(v, c)' : 'vec2<f32>(c, v)';
	const value = curve.swap ? 'q.x' : 'q.y';
	return /* wgsl */ `
${getCurveWGSL(curve.curve)}
fn curvePoint(c: f32, v: f32) -> vec2<f32> { return ${point}; }
fn curveSample(
  v0: f32, v1: f32, v2: f32, v3: f32,
  c0: f32, c1: f32, c2: f32, c3: f32,
  t: f32
) -> f32 {
  let q = evaluateCurve(curvePoint(c0, v0), curvePoint(c1, v1), curvePoint(c2, v2), curvePoint(c3, v3), t);
  return ${value};
}
`;
}

export const REMAP_IMMEDIATE_SIZE = 48;

/** `to` re-expressed in the units of `drawn`: T⁻¹. */
function intoDrawnExpr(kind: RemapKind, v: string): string {
	if (kind === 'none') return v;
	return `select(${invertExpr(kind, normalizeExpr(kind, v, 'current'), 'drawn')}, ${v}, drawn.p3 == 0.0)`;
}

export function remapShader(kind: RemapKind, curve: RemapCurve | null = null): string {
	return /* wgsl */ `
requires immediate_address_space;
${curve ? curveSampleWGSL(curve) : ''}

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

  ${
		curve
			? `
  // A point sampled between old points k and k + 1: on the drawn curve.
  let first = map[offsetsAt + b];
  if (map[5] == 1u && map[offsetsAt + b + 1u] - first == 2u) {
    let centreAt = uncoveredAt + newBins;
    let k = map[oldBinAt + first];
    let t = bitcast<f32>(map[weightAt + first + 1u]);
    let k0 = select(k, k - 1u, k > 0u);
    let k3 = select(k + 1u, k + 2u, k + 2u < oldBins);
    let base = f * oldBins;
    valueFrom[j] = curveSample(
      old[(base + k0) * series + s], old[(base + k) * series + s],
      old[(base + k + 1u) * series + s], old[(base + k3) * series + s],
      bitcast<f32>(map[centreAt + k0]), bitcast<f32>(map[centreAt + k]),
      bitcast<f32>(map[centreAt + k + 1u]), bitcast<f32>(map[centreAt + k3]),
      t
    );
    return;
  }`
			: ''
	}
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

/**
 * A curve's value at `t` in JS, for the references: `linear` and the
 * monotone curves (CurveShaderLib's monotoneInterp, transcribed), the curves
 * the tests sample. Others throw: their WGSL is what runs.
 */
function curveReference(curve: RemapCurve) {
	const monotone = (
		i0: number,
		d0: number,
		i1: number,
		d1: number,
		i2: number,
		d2: number,
		i3: number,
		d3: number,
		t: number
	): number => {
		const h0 = i1 - i0;
		const h1 = i2 - i1;
		const h2 = i3 - i2;
		if (Math.abs(h1) < 0.001) return d1 + (d2 - d1) * t;
		const s0 = Math.abs(h0) < 0.001 ? 0 : (d1 - d0) / h0;
		const s1 = (d2 - d1) / h1;
		const s2 = Math.abs(h2) < 0.001 ? 0 : (d3 - d2) / h2;
		const m1 =
			Math.abs(h0) < 0.001
				? s1
				: s0 * s1 <= 0
					? 0
					: (3 * (h0 + h1)) / ((h0 + 2 * h1) / s0 + (2 * h0 + h1) / s1);
		const m2 =
			Math.abs(h2) < 0.001
				? s1
				: s1 * s2 <= 0
					? 0
					: (3 * (h1 + h2)) / ((h1 + 2 * h2) / s1 + (2 * h1 + h2) / s2);
		const t2 = t * t;
		const t3 = t2 * t;
		return (
			(2 * t3 - 3 * t2 + 1) * d1 +
			(t3 - 2 * t2 + t) * (m1 * h1) +
			(-2 * t3 + 3 * t2) * d2 +
			(t3 - t2) * (m2 * h1)
		);
	};
	return (v: number[], c: number[], t: number): number => {
		if (curve.curve === 'linear') return v[1] + (v[2] - v[1]) * t;
		if (curve.curve === 'monotone-x' || curve.curve === 'monotone-y') {
			return monotone(c[0], v[0], c[1], v[1], c[2], v[2], c[3], v[3], t);
		}
		throw new Error(`curveReference: no reference for ${curve.curve}`);
	};
}

/**
 * The reference's sampling: what the kernel's curve branch computes for new
 * bin \`b\`, or undefined when it does not apply (no curve, not a point map, not
 * two sources).
 */
function sampleReference(
	curve: RemapCurve | null,
	map: Uint32Array,
	floats: Float32Array,
	b: number,
	at: { offsets: number; bins: number; weights: number; centres: number },
	sideBins: number,
	read: (bin: number) => number
): number | undefined {
	if (!curve || map[5] !== 1) return undefined;
	const first = map[at.offsets + b];
	if (map[at.offsets + b + 1] - first !== 2) return undefined;
	const k = map[at.bins + first];
	const t = floats[at.weights + first + 1];
	const ks = [k > 0 ? k - 1 : k, k, k + 1, k + 2 < sideBins ? k + 2 : k + 1];
	return curveReference(curve)(
		ks.map(read),
		ks.map((i) => floats[at.centres + i]),
		t
	);
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
	out: Float32Array,
	curve: RemapCurve | null = null
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
		const sampled = sampleReference(
			curve,
			map,
			floats,
			b,
			{ offsets: offsetsAt, bins: oldBinAt, weights: weightAt, centres: uncoveredAt + newBins },
			oldBins,
			(k) => old[(f * oldBins + k) * series + s]
		);
		if (sampled !== undefined) {
			out[j] = sampled;
			continue;
		}
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

const PIPELINES = new WeakMap<GPUDevice, Map<string, RemapPipeline>>();

/** The pipeline cache's key for a curve: none, or its name and orientation. */
const curveKey = (curve: RemapCurve | null) =>
	curve ? `${curve.curve}${curve.swap ? '-swap' : ''}` : 'weights';

/** One remap pipeline per device, kind and curve, shared by every morphing mark. */
export function remapPipelineFor(
	device: GPUDevice,
	kind: RemapKind,
	curve: RemapCurve | null = null
): RemapPipeline {
	let byKind = PIPELINES.get(device);
	if (!byKind) {
		byKind = new Map();
		PIPELINES.set(device, byKind);
	}
	const key = `${kind}|${curveKey(curve)}`;
	let entry = byKind.get(key);
	if (!entry) {
		const stage = GPUShaderStage.COMPUTE;
		const label = curve ? `remap-${kind}-${curveKey(curve)}` : `remap-${kind}`;
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
				module: device.createShaderModule({ label, code: remapShader(kind, curve) }),
				entryPoint: 'main'
			}
		});
		entry = { pipeline, layout };
		byKind.set(key, entry);
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

export function gatherShader(curve: RemapCurve | null = null): string {
	return /* wgsl */ `
requires immediate_address_space;
${curve ? curveSampleWGSL(curve) : ''}

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

  ${
		curve
			? `
  // A held point sampled between new points k and k + 1: on the new curve.
  let first = map[offsetsAt + b];
  if (map[5] == 1u && map[offsetsAt + b + 1u] - first == 2u) {
    let centreAt = uncoveredAt + dstBins;
    let k = map[srcBinAt + first];
    let t = bitcast<f32>(map[weightAt + first + 1u]);
    let k0 = select(k, k - 1u, k > 0u);
    let k3 = select(k + 1u, k + 2u, k + 2u < srcBins);
    let base = f * srcBins;
    dst[j] = curveSample(
      src[(base + k0) * series + s], src[(base + k) * series + s],
      src[(base + k + 1u) * series + s], src[(base + k3) * series + s],
      bitcast<f32>(map[centreAt + k0]), bitcast<f32>(map[centreAt + k]),
      bitcast<f32>(map[centreAt + k + 1u]), bitcast<f32>(map[centreAt + k3]),
      t
    );
    return;
  }`
			: ''
	}
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
	count: number,
	curve: RemapCurve | null = null
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
		const sampled = sampleReference(
			curve,
			map,
			floats,
			b,
			{ offsets: offsetsAt, bins: srcBinAt, weights: weightAt, centres: uncoveredAt + dstBins },
			srcBins,
			(k) => src[(f * srcBins + k) * series + s]
		);
		if (sampled !== undefined) {
			dst[j] = sampled;
			continue;
		}
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

const GATHER_PIPELINES = new WeakMap<GPUDevice, Map<string, RemapPipeline>>();

/** One gather pipeline per device and curve, shared by every holding mark. */
export function gatherPipelineFor(
	device: GPUDevice,
	curve: RemapCurve | null = null
): RemapPipeline {
	let byCurve = GATHER_PIPELINES.get(device);
	if (!byCurve) {
		byCurve = new Map();
		GATHER_PIPELINES.set(device, byCurve);
	}
	const key = curveKey(curve);
	let entry = byCurve.get(key);
	if (!entry) {
		const stage = GPUShaderStage.COMPUTE;
		const label = curve ? `gather-${key}` : 'gather';
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
				module: device.createShaderModule({ label, code: gatherShader(curve) }),
				entryPoint: 'main'
			}
		});
		entry = { pipeline, layout };
		byCurve.set(key, entry);
	}
	return entry;
}
