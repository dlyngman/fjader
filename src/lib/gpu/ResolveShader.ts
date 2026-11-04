import { isNanExpr } from './NanShaderLib';
/**
 * The resolve kernel: `resolved[j] = mix(from[j], to[j], t)` over one range.
 *
 * Every animated thing on the GPU goes through this: a mark's morphing channels
 * and every band, point and ordinal colour scale's slot table. `from` and `to`
 * are bound to the compute pipeline; the render stages bind `resolved` alone.
 * So an animated channel REPLACES a vertex binding rather than adding one, and
 * animating any number of channels leaves that stage's budget where it was —
 * which is what makes this affordable on a mark that already sits at the
 * default limit of 8.
 *
 * ONE KERNEL FOR BOTH, because the two differ only in where a range starts. A
 * value channel is one mark's rows in buffers of their own, so it starts at 0.
 * The slot tables share one buffer, a block per scale, so each scale's
 * dispatch starts at its block's base. Each dispatch carries its own `t` as an
 * immediate, which is what lets several scales at different points in their
 * transitions resolve in one pass with no lookup of which block a thread is in.
 *
 * NaN, AND WHY IT SNAPS.
 *
 * The pipeline encodes SQL NULL as NaN — that is what `coalesce(expr::REAL,
 * 'NaN'::REAL)` is for, and it is why Arrow columns reach the GPU with no
 * validity bitmap. So a NaN can be on either side of a transition, and
 * `mix(NaN, x, t)` is NaN for every t: a row that is null in `from` and valid in
 * `to` would never appear, for the whole transition and after it. Silently, and
 * permanently.
 *
 * The choice here is that a NaN on EITHER side takes `to` immediately, with no
 * interpolation. Rationale, since the alternative is tempting:
 *
 * - **Interpolating from 0 instead would be wrong for half the channels.** For a
 *   bar's extent, growing from 0 is exactly right. For a scatter point's x
 *   position, 0 is a meaningless place to travel from — the point would fly in
 *   from the origin. The kernel does not know which kind of channel it holds, so
 *   it cannot pick.
 * - **The database is the right place to decide what absent means**, and it
 *   already does: the dense topN join coalesces an excluded category's measure
 *   to 0, so a departing bar shrinks 50 -> 0 through this kernel with no NaN
 *   involved at all. Enter and leave animate because SQL said 0, not because the
 *   shader guessed.
 * - So NaN here means "genuinely no value", and snapping is the honest answer:
 *   the row appears or disappears rather than animating through a number that
 *   was never in the data.
 *
 * A slot table never holds NaN, so for it the select does the other job below.
 *
 * EQUAL ENDS ARE RETURNED EXACTLY.
 *
 * WGSL defines `mix(a, b, t)` as `a * (1 - t) + b * t`, which in f32 need not
 * give back `a` when `b == a`: `mix(3, 3, 0.007)` is 2.9999998. A slot block's
 * count header is the same in both halves and the render stages read it with
 * `u32()`, which truncates — so an inexact mix drops the last id for that frame.
 * Metal happens to lower `mix` to `a + (b - a) * t`, exact here; Vulkan's FMix
 * is free not to. So equal ends take `b` explicitly: the count header, a hidden
 * id's -1, and every slot not moving in a reorder all come out exactly as
 * packed, whatever the driver. `mix` itself stays for the rest, because it is
 * exact at both t = 0 and t = 1, where `a + (b - a) * t` is not at t = 1.
 */

/** Threads per workgroup. 64 is the usual floor for good occupancy. */
export const RESOLVE_WORKGROUP = 64;

/** Bytes of immediate data the kernel reads: `count`, `t`, `offset`. */
export const RESOLVE_IMMEDIATE_SIZE = 12;

/**
 * `count`, `t` and `offset` arrive as IMMEDIATES — set on the pass right before
 * each dispatch — rather than in a uniform buffer.
 *
 * A uniform would need one buffer per dispatch: queue writes all land before
 * any command in the submit, so one buffer rewritten between dispatches would
 * hand every dispatch the last one's values. Immediates are pass state, set in
 * command order, so each dispatch reads its own.
 */
export const RESOLVE_SHADER = /* wgsl */ `
requires immediate_address_space;

struct Params {
  // Elements in this range. The rest of the buffer is left alone.
  count: u32,
  // 0 -> from, 1 -> to. Shared by every element of the range.
  t: f32,
  // Where the range starts, in all three buffers alike.
  offset: u32,
};

@group(0) @binding(0) var<storage, read>       valueFrom: array<f32>;
@group(0) @binding(1) var<storage, read>       valueTo:   array<f32>;
@group(0) @binding(2) var<storage, read_write> resolved:  array<f32>;
var<immediate> params: Params;

@compute @workgroup_size(${RESOLVE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.count) {
    return;
  }
  let j = params.offset + gid.x;
  let a = valueFrom[j];
  let b = valueTo[j];
  // A NaN on either side means one end of this transition is not a number, so
  // there is nothing to interpolate along. Take the destination and be done.
  // Note the test has to be explicit, and on the bits: mix() would silently
  // propagate a NaN, and a compiler may fold a float test like a != a to false.
  // Equal ends take b too, so they come out exact on any driver — see above.
  let takeTo = a == b || ${isNanExpr('a')} || ${isNanExpr('b')};
  resolved[j] = select(mix(a, b, params.t), b, takeTo);
}
`;

/**
 * The same expression in JS, and the reason it exists.
 *
 * Logic that lives only in WGSL is reachable only through a device, so the
 * formula is written here too and the shader is asserted against it. If this
 * changes, the WGSL changes in the same commit and the comparison test fails if
 * it does not.
 */
export function resolveReference(
	valueFrom: Float32Array,
	valueTo: Float32Array,
	t: number,
	count: number,
	out: Float32Array,
	offset: number = 0
): Float32Array {
	for (let j = offset; j < offset + count; j++) {
		const a = valueFrom[j];
		const b = valueTo[j];
		out[j] = a === b || Number.isNaN(a) || Number.isNaN(b) ? b : a + (b - a) * t;
	}
	return out;
}

export interface ResolvePipeline {
	pipeline: GPUComputePipeline;
	layout: GPUBindGroupLayout;
}

const PIPELINES = new WeakMap<GPUDevice, ResolvePipeline>();

/**
 * One resolve pipeline per device, shared by every caller: the kernel does not
 * know what it is resolving.
 *
 * An explicit layout rather than 'auto', so the immediate range is stated here
 * and not left to how a default layout infers it.
 */
export function resolvePipelineFor(device: GPUDevice): ResolvePipeline {
	let entry = PIPELINES.get(device);
	if (!entry) {
		const stage = GPUShaderStage.COMPUTE;
		const layout = device.createBindGroupLayout({
			label: 'resolve',
			entries: [
				{ binding: 0, visibility: stage, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: stage, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: stage, buffer: { type: 'storage' } }
			]
		});
		const pipeline = device.createComputePipeline({
			label: 'resolve',
			layout: device.createPipelineLayout({
				label: 'resolve',
				bindGroupLayouts: [layout],
				immediateSize: RESOLVE_IMMEDIATE_SIZE
			}),
			compute: {
				module: device.createShaderModule({ label: 'resolve', code: RESOLVE_SHADER }),
				entryPoint: 'main'
			}
		});
		entry = { pipeline, layout };
		PIPELINES.set(device, entry);
	}
	return entry;
}
