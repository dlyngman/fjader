/**
 * Packing for the shared identity slot table (§9.5, §14.3).
 *
 * Named for band scales until ordinal colour needed it too. It was never
 * band-specific: it maps an identity id to that scale's display position, and
 * the channels wanting that are band and point axes, the facet grid, and
 * ordinal colour.
 *
 * Every band and point scale's `slotTable` — identity id -> display slot —
 * lives in ONE uniform buffer, at a per-scale base the scale carries in its p4.
 * This module decides where each block goes and what the buffer holds; the
 * coordinator owns the GPU buffer and the upload.
 *
 * Extracted from GPUCoordinator because it is the most conditional logic on the
 * band identity path — a running-sum allocator, a capacity fallback, a
 * transition-only warning and an eviction sweep — and it was reachable only
 * through a real WebGPU device, so a browser exercised it and nothing asserted
 * on it (§20.4 C). It is a pure function over plain arrays and maps, which is
 * what it should have been.
 *
 * Layout: index 0 is a permanent zero-length block, then one block per scale of
 * `[count, slot0, slot1, ...]`. The count header makes each block
 * self-describing, so the shader rejects an id past this scale's end instead of
 * reading into the next scale's slots — ids and the slot table can disagree
 * transiently while a dim appends. Budget is therefore
 * `capacity - 1 - (1 per scale)` slots.
 */

/**
 * 16384 floats GLOBALLY across every band and point scale on the page.
 *
 * A uniform buffer, not storage: the vertex stage is already at the default
 * maxStorageBuffersPerShaderStage of 8. 64 KB is the default
 * maxUniformBufferBindingSize, and 64 KB / 4 is this.
 */
export const IDENTITY_SLOT_CAPACITY = 16384;

/**
 * Base of the permanent zero-length block. A scale that cannot be placed points
 * here, so every lookup finds count 0 and discards — which is what the capacity
 * warning claims happens. Pointing it at a stale base instead left the scale
 * rendering, from another scale's slots.
 */
export const IDENTITY_SLOT_EMPTY = 0;

/** The parts of a band/point scale this needs. */
export interface IdentitySlotScale {
	id: string;
	/** id -> display slot, or -1 for an id not currently shown. */
	slotTable: Float32Array;
	/** Bumped by the scale on every slot-table rebuild. */
	slotVersion?: number;
}

/** Everything that persists between calls. */
export interface IdentitySlotState {
	/** CPU mirror of the uniform buffer. */
	buffer: Float32Array;
	/** Per-scale base offset, read back into p4. */
	offsets: Map<string, number>;
	/** Last packed slotVersion per scale, so a static chart re-uploads nothing. */
	versions: Map<string, number>;
}

/** A state with the permanent empty block in place. */
export function createIdentitySlotState(
	capacity: number = IDENTITY_SLOT_CAPACITY
): IdentitySlotState {
	const buffer = new Float32Array(capacity);
	buffer.fill(-1);
	// The permanent empty block: count 0, so it holds no slots.
	buffer[IDENTITY_SLOT_EMPTY] = 0;
	return { buffer, offsets: new Map(), versions: new Map() };
}

/**
 * Assign every scale a base and write its block, returning what to upload.
 *
 * `dirty` is false when nothing moved — slot tables change on reorder, not per
 * frame, so a static chart costs no writeBuffer. `length` is how much of the
 * buffer is in use, so the caller uploads a prefix rather than all 64 KB.
 *
 * Offsets are recomputed on every call because a scale appearing or
 * disappearing shifts every scale after it. That is a running sum over a
 * handful of scales, and the alternative — a free list — would have to survive
 * a scale changing size, which happens whenever a dim appends.
 */
export function packIdentitySlots(
	scales: readonly IdentitySlotScale[],
	state: IdentitySlotState
): { dirty: boolean; length: number } {
	const { buffer, offsets, versions } = state;
	const capacity = buffer.length;

	// Index 0 is the permanent empty block; real blocks start after it.
	let offset = 1;
	let dirty = false;
	const seen = new Set<string>();

	for (const scale of scales) {
		const table = scale.slotTable;
		seen.add(scale.id);

		// One extra float for the block's count header.
		const need = table.length + 1;
		const fits = offset + need <= capacity;
		const base = fits ? offset : IDENTITY_SLOT_EMPTY;
		if (fits) offset += need;

		if (offsets.get(scale.id) !== base || versions.get(scale.id) !== scale.slotVersion) {
			if (fits) {
				buffer[base] = table.length;
				buffer.set(table, base + 1);
			} else {
				// Warn on the transition only — the caller runs this every frame.
				console.warn(
					`[GPUCoordinator] Band slot capacity (${capacity}) exhausted; ` +
						`scale "${scale.id}" (${table.length} ids) will not render.`
				);
			}
			offsets.set(scale.id, base);
			versions.set(scale.id, scale.slotVersion ?? 0);
			dirty = true;
		}
		// No break: a later scale with a smaller table may still fit, and one
		// that does not is parked on the empty block rather than left holding a
		// base that now belongs to someone else.
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
			}
		}
	}

	return { dirty, length: offset };
}
