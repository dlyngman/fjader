/**
 * The slot resolve kernel.
 *
 * One compute pass per frame writes `resolved[i] = mix(from[i], to[i], t)` for
 * every float of the packed slot table, and the vertex and fragment stages read
 * `resolved` alone. That is the whole argument for doing it this way: the second
 * buffer never reaches the render stages, so animating a channel costs their
 * binding budget nothing.
 *
 * WHY t COMES FROM A LOOKUP. `t` is per scale and lives in that scale's block
 * header, but blocks are variable-length, so a flat thread cannot find its own
 * header by arithmetic. `bases[i]` says which block float `i` belongs to. That
 * is what makes this ONE dispatch for the whole page rather than one per scale —
 * and the per-scale alternative has a silent bug waiting in it, because
 * per-dispatch constants need push constants, and writing a uniform between
 * dispatches in a single encoder does not work: queue writes all land before any
 * command in the submit, so the last write would win for every dispatch.
 *
 * WHY HEADERS ARE RESOLVED TOO, rather than skipped. `count` sits at `base` in
 * both halves, so `mix(count, count, t)` is `count` and the header survives
 * untouched — the vertex stage still reads its bound there. `t` at `base + 1`
 * resolves to something meaningless, and nothing reads it. Two branchless writes
 * are cheaper than the guard that would avoid them.
 *
 * WHY THERE IS NO SENTINEL BRANCH. An id that is not displayed holds -1 in both
 * halves, so the mix returns -1 for any t; a leaver holds a real slot in both,
 * which is what lets it travel. `BandScaleState` normalises that before packing,
 * so this kernel does not re-derive it.
 */

/** Threads per workgroup. 64 is the usual floor for good occupancy. */
export const SLOT_RESOLVE_WORKGROUP = 64;

export const SLOT_RESOLVE_SHADER = /* wgsl */ `
struct Params {
  // How much of the packed buffer is in use. The tail is untouched rather than
  // resolved to junk — nothing reads it, but a NaN there would be a confusing
  // thing to find in a buffer dump.
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<storage, read>       slotFrom: array<f32>;
@group(0) @binding(1) var<storage, read>       slotTo:   array<f32>;
@group(0) @binding(2) var<storage, read>       bases:    array<u32>;
@group(0) @binding(3) var<storage, read_write> resolved: array<f32>;
@group(0) @binding(4) var<uniform>             params:   Params;

@compute @workgroup_size(${SLOT_RESOLVE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) {
    return;
  }
  // t lives at offset 1 of this element's own block.
  let t = slotFrom[bases[i] + 1u];
  resolved[i] = mix(slotFrom[i], slotTo[i], t);
}
`;

/**
 * The same expression in JS, and the reason it exists.
 *
 * Logic that lives only in WGSL is reachable only through a device, which is the
 * condition that got the packer extracted in the first place. This is the
 * reference the shader is asserted against, so the formula has something to be
 * wrong against — `ef70743` did the same for the vertex-stage mix it replaces.
 *
 * Keep the two in step by construction: if this changes, the WGSL above changes
 * in the same commit, and the test that compares them fails if it does not.
 */
export function resolveSlotsReference(
	slotFrom: Float32Array,
	slotTo: Float32Array,
	bases: Uint32Array,
	count: number,
	out: Float32Array
): Float32Array {
	for (let i = 0; i < count; i++) {
		const t = slotFrom[bases[i] + 1];
		out[i] = slotFrom[i] + (slotTo[i] - slotFrom[i]) * t;
	}
	return out;
}
