/**
 * Packing for the shared identity slot table.
 *
 * Named for band scales until ordinal colour needed it too. It was never
 * band-specific: it maps an identity id to that scale's display position, and
 * the channels wanting that are band and point axes, the facet grid, and
 * ordinal colour.
 *
 * Every band and point scale's slot table — identity id -> display slot —
 * lives in ONE shared table, at a per-scale base the scale carries in its p4.
 * This module decides where each block goes and what the buffer holds; the
 * coordinator owns the GPU buffer and the upload.
 *
 * Extracted from GPUCoordinator because it is the most conditional logic on the
 * band identity path — a running-sum allocator, a capacity fallback, a
 * transition-only warning and an eviction sweep — and it was reachable only
 * through a real WebGPU device, so a browser exercised it and nothing asserted
 * on it. It is a pure function over plain arrays and maps, which is
 * what it should have been.
 *
 * Layout: index 0 is a permanent zero-length block, then one block per scale of
 * `[count, slot0, slot1, ...]`. The count header makes each block
 * self-describing, so the shader rejects an id past this scale's end instead of
 * reading into the next scale's slots — ids and the slot table can disagree
 * transiently while a dim appends. Budget is therefore
 * `capacity - 1 - (1 per scale)` slots.
 *
 * TWO buffers share one set of offsets: `from` is where each id's current
 * transition started and `to` where it is going, and the resolve kernel writes
 * `mix(from[id], to[id], t)` into a third that the render stages read. Two
 * bindings rather than two runs in one buffer, so the halves line up at the
 * same base and one dispatch per block covers both.
 *
 * `t` is not in the buffers. It is PER SCALE — each band scale has its own
 * driver — and reaches the kernel as an immediate on that scale's dispatch, so
 * a frame where only `t` moved uploads nothing at all.
 */

/**
 * Floats GLOBALLY across every band and point scale on the page, headers
 * included.
 *
 * No longer a binding limit: the tables are storage buffers, bound only to the
 * resolve pass, and the render stages read one resolved storage buffer. The
 * number is left over from when they were 64 KB uniforms, and making the
 * allocation grow on demand (recreate the buffers, rebuild the bind groups) is
 * what would retire it.
 */
export const IDENTITY_SLOT_CAPACITY = 16384;

/**
 * Base of the permanent zero-length block. A scale that cannot be placed points
 * here, so every lookup finds count 0 and discards — which is what the capacity
 * warning claims happens. Pointing it at a stale base instead left the scale
 * rendering, from another scale's slots.
 */
export const IDENTITY_SLOT_EMPTY = 0;

/**
 * One scale's slot table as the packer reads it: identity id -> display slot,
 * as the two ends of a transition and where between them it is.
 *
 * One shape for every scale. A scale that does not animate — ordinal colour —
 * hands the same table as both ends with `t` at 1, which makes the resolve an
 * identity for it rather than a special case here or in the shader.
 */
export interface SlotSource {
	/** How many ids the block holds — its count header, and the length of `from` and `to`. */
	readonly count: number;
	/** Where each id's transition started; -1 for an id not shown. */
	readonly from: Float32Array;
	/** Where each id's transition is going; -1 for an id not shown. */
	readonly to: Float32Array;
	/** 0 -> from, 1 -> to. */
	readonly t: number;
	/** Bumped whenever `from` or `to` move; the packer re-uploads on it alone. */
	readonly version: number;
}

/** A scale with a slot table, as the packer needs it. */
export interface IdentitySlotScale {
	id: string;
	slots: SlotSource;
}

/**
 * One block to resolve this frame: `length` floats from `base`, at `t`.
 *
 * The count header is inside the range rather than skipped: it holds the same
 * value in both halves, so mixing it returns it, and the render stages read
 * their bound from the resolved copy. Pooled in the state and overwritten by
 * the next pack.
 */
export interface ResolveBlock {
	base: number;
	length: number;
	t: number;
}

/** What a pack produced. Owned by the state and overwritten by the next pack. */
export interface PackResult {
	/**
	 * The float range `[uploadStart, uploadEnd)` of both buffers that was
	 * rewritten. Empty when nothing moved — slot tables change on a reorder, not
	 * per frame, so a static chart costs no writeBuffer. A range rather than the
	 * whole used prefix, so one small scale reordering does not re-upload every
	 * other scale's table with it.
	 */
	uploadStart: number;
	uploadEnd: number;
	/** The first `resolveCount` entries are this frame's dispatches. */
	resolves: ResolveBlock[];
	resolveCount: number;
}

/** Everything that persists between calls. */
export interface IdentitySlotState {
	/** CPU mirror of the `from` buffer, headers included. */
	buffer: Float32Array;
	/** CPU mirror of the `to` buffer. Same offsets, same headers. */
	bufferTo: Float32Array;
	/** Per-scale base offset, read back into p4. */
	offsets: Map<string, number>;
	/** Last packed slotVersion per scale, so a static chart re-uploads nothing. */
	versions: Map<string, number>;
	/**
	 * The `t` each scale's block was last resolved at, so a still frame
	 * dispatches nothing and an animating one dispatches only the scales that
	 * are moving.
	 */
	resolvedT: Map<string, number>;
	/** Scratch for the eviction sweep; cleared, not reallocated, per pack. */
	seen: Set<string>;
	/** Returned by every pack and overwritten by the next — read it immediately. */
	result: PackResult;
}

/** A state with the permanent empty block in place. */
export function createIdentitySlotState(
	capacity: number = IDENTITY_SLOT_CAPACITY
): IdentitySlotState {
	const buffer = new Float32Array(capacity);
	const bufferTo = new Float32Array(capacity);
	buffer.fill(-1);
	bufferTo.fill(-1);
	// The permanent empty block: count 0, so it holds no slots.
	buffer[IDENTITY_SLOT_EMPTY] = 0;
	bufferTo[IDENTITY_SLOT_EMPTY] = 0;
	return {
		buffer,
		bufferTo,
		offsets: new Map(),
		versions: new Map(),
		resolvedT: new Map(),
		seen: new Set(),
		result: { uploadStart: 0, uploadEnd: 0, resolves: [], resolveCount: 0 }
	};
}

/**
 * Assign every scale a base, write the blocks that moved, and list what to
 * upload and what to resolve.
 *
 * A block is REWRITTEN when its base or its version moved, and RESOLVED when it
 * was rewritten or its `t` moved. A parked scale is neither: it has no block,
 * and the empty block it points at is never written.
 *
 * Offsets are recomputed on every call because a scale appearing or
 * disappearing shifts every scale after it. That is a running sum over a
 * handful of scales, and the alternative — a free list — would have to survive
 * a scale changing size, which happens whenever a dim appends.
 */
export function packIdentitySlots(
	scales: readonly IdentitySlotScale[],
	state: IdentitySlotState
): PackResult {
	const { buffer, bufferTo, offsets, versions, resolvedT, result } = state;
	const capacity = buffer.length;
	const resolves = result.resolves;

	// Index 0 is the permanent empty block; real blocks start after it.
	let offset = 1;
	let uploadStart = capacity;
	let uploadEnd = 0;
	let resolveCount = 0;
	// Runs every frame: the scratch set and the result are the state's own.
	const seen = state.seen;
	seen.clear();

	for (let i = 0; i < scales.length; i++) {
		const scale = scales[i];
		seen.add(scale.id);

		const slots = scale.slots;
		// One extra float for the block's count header.
		const need = slots.count + 1;
		const fits = offset + need <= capacity;
		const base = fits ? offset : IDENTITY_SLOT_EMPTY;
		if (fits) offset += need;

		const version = slots.version;
		let rewritten = false;
		if (offsets.get(scale.id) !== base || versions.get(scale.id) !== version) {
			if (fits) {
				buffer[base] = slots.count;
				buffer.set(slots.from, base + 1);
				bufferTo[base] = slots.count;
				bufferTo.set(slots.to, base + 1);
				if (base < uploadStart) uploadStart = base;
				if (base + need > uploadEnd) uploadEnd = base + need;
				rewritten = true;
			} else {
				// Warn on the transition only — the caller runs this every frame.
				console.warn(
					`[GPUCoordinator] Band slot capacity (${capacity}) exhausted; ` +
						`scale "${scale.id}" (${slots.count} ids) will not render.`
				);
			}
			offsets.set(scale.id, base);
			versions.set(scale.id, version);
		}
		// No break: a later scale with a smaller table may still fit, and one
		// that does not is parked on the empty block rather than left holding a
		// base that now belongs to someone else.

		if (!fits) continue;
		const t = slots.t;
		if (!rewritten && resolvedT.get(scale.id) === t) continue;
		resolvedT.set(scale.id, t);
		const block = (resolves[resolveCount++] ??= { base: 0, length: 0, t: 0 });
		block.base = base;
		block.length = need;
		block.t = t;
	}

	// Drop entries for scales that have gone away, so a re-registered id cannot
	// inherit a base from a previous life. `offsets` is a superset of `seen` by
	// construction — every scale above is written — so comparing sizes is a
	// sound test for set equality and not just a cheap approximation of one.
	if (offsets.size !== seen.size) {
		for (const id of [...offsets.keys()]) {
			if (!seen.has(id)) {
				offsets.delete(id);
				versions.delete(id);
				resolvedT.delete(id);
			}
		}
	}

	result.uploadStart = uploadEnd > 0 ? uploadStart : 0;
	result.uploadEnd = uploadEnd;
	result.resolveCount = resolveCount;
	return result;
}
