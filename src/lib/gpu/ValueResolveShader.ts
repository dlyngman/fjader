/**
 * The value resolve kernel: `resolved[i] = mix(from[i], to[i], t)` per row.
 *
 * The sibling of the slot resolve, and the same trade. `from` and `to` are bound
 * to the compute pipeline; the vertex stage binds `resolved` alone, in place of
 * the static channel buffer it would otherwise bind. So an animated channel
 * REPLACES a vertex binding rather than adding one, and animating any number of
 * channels leaves that stage's budget where it was — which is what makes this
 * affordable on a mark that already sits at the default limit of 8.
 *
 * WHY THIS IS NOT THE SLOT KERNEL. A slot table holds several scales' blocks in
 * one buffer, each with its own `t`, so a thread there has to look up which
 * block it is in. A value channel is one mark's rows with one `t` for all of
 * them, so the parameter is a scalar and there is nothing to look up. Sharing a
 * kernel between the two would mean carrying a per-element indirection for the
 * case that does not need it.
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
 */

/** Threads per workgroup. Matches the slot kernel. */
export const VALUE_RESOLVE_WORKGROUP = 64;

export const VALUE_RESOLVE_SHADER = /* wgsl */ `
struct Params {
  // Rows in use. The tail of an over-allocated buffer is left alone.
  count: u32,
  // 0 -> from, 1 -> to. Shared by every row of this channel.
  t: f32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<storage, read>       valueFrom: array<f32>;
@group(0) @binding(1) var<storage, read>       valueTo:   array<f32>;
@group(0) @binding(2) var<storage, read_write> resolved:  array<f32>;
@group(0) @binding(3) var<uniform>             params:    Params;

@compute @workgroup_size(${VALUE_RESOLVE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) {
    return;
  }
  let a = valueFrom[i];
  let b = valueTo[i];
  // A NaN on either side means one end of this transition is not a number, so
  // there is nothing to interpolate along. Take the destination and be done.
  // Note the test has to be explicit: every comparison against NaN is false, so
  // mix() would silently propagate it instead.
  let undefinedEnd = a != a || b != b;
  resolved[i] = select(mix(a, b, params.t), b, undefinedEnd);
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
export function resolveValuesReference(
	valueFrom: Float32Array,
	valueTo: Float32Array,
	t: number,
	count: number,
	out: Float32Array
): Float32Array {
	for (let i = 0; i < count; i++) {
		const a = valueFrom[i];
		const b = valueTo[i];
		out[i] = Number.isNaN(a) || Number.isNaN(b) ? b : a + (b - a) * t;
	}
	return out;
}
