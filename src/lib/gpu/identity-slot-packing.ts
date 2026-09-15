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
 * `[count, t, slot0, slot1, ...]`. The count header makes each block
 * self-describing, so the shader rejects an id past this scale's end instead of
 * reading into the next scale's slots — ids and the slot table can disagree
 * transiently while a dim appends. Budget is therefore
 * `capacity - 1 - (2 per scale)` slots.
 *
 * TWO buffers share one set of offsets: `from` is where each id's current
 * transition started and `to` where it is going, and the shader reads
 * `mix(from[id], to[id], t)`. Two bindings rather than two runs in one buffer,
 * because one buffer would halve the id ceiling while uniform bindings are at
 * three of a default twelve.
 *
 * `t` lives in the block header because it is PER SCALE — each band scale has
 * its own driver — and a band scale's four scaleParams floats are all spoken
 * for (categoryCount, paddingInner, paddingOuter, slot base). Putting it here
 * costs one float per scale and makes the per-frame upload a 4-byte write at a
 * known offset instead of re-uploading every slot.
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
	/**
	 * Where each id's transition started and where it is going. Both optional:
	 * a scale that does not animate — ordinal colour, facet — offers neither,
	 * and gets `slotTable` in both buffers, which makes the shader's mix an
	 * identity for it rather than a special case.
	 */
	slotFrom?: Float32Array;
	slotTo?: Float32Array;
	/** Interpolation parameter, 1 (settled) unless a driver is running. */
	t?: number;
	/** Bumped by the scale on every slot-table rebuild. */
	slotVersion?: number;
}

/** Everything that persists between calls. */
export interface IdentitySlotState {
	/** CPU mirror of the `from` uniform buffer, and of the header. */
	buffer: Float32Array;
	/** CPU mirror of the `to` uniform buffer. Same offsets, same headers. */
	bufferTo: Float32Array;
	/**
	 * Which scale's block each float belongs to, parallel to `buffer`.
	 *
	 * The resolve kernel needs `t` for the element it is working on, and `t`
	 * lives in that element's block header. Blocks are variable-length, so a
	 * flat thread cannot find its own header by arithmetic — this is the lookup
	 * that lets it, and it turns the whole page into ONE dispatch instead of one
	 * per scale.
	 *
	 * Uint32 rather than Float32 because it is an index, and it is uploaded only
	 * when the packing moves — a reorder or a scale appearing — never per frame.
	 * Header floats point at their own block, so a thread landing on one reads
	 * its own `t` and writes a value nothing reads. Cheaper than excluding them.
	 */
	bases: Uint32Array;
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
	const bufferTo = new Float32Array(capacity);
	const bases = new Uint32Array(capacity);
	buffer.fill(-1);
	bufferTo.fill(-1);
	// The permanent empty block: count 0, so it holds no slots.
	buffer[IDENTITY_SLOT_EMPTY] = 0;
	bufferTo[IDENTITY_SLOT_EMPTY] = 0;
	return { buffer, bufferTo, bases, offsets: new Map(), versions: new Map() };
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
	const { buffer, bufferTo, bases, offsets, versions } = state;
	const capacity = buffer.length;

	// Index 0 is the permanent empty block; real blocks start after it.
	let offset = 1;
	let dirty = false;
	const seen = new Set<string>();

	for (const scale of scales) {
		const table = scale.slotTable;
		seen.add(scale.id);

		// Two extra floats for the block's header: count, then t.
		const need = table.length + 2;
		const fits = offset + need <= capacity;
		const base = fits ? offset : IDENTITY_SLOT_EMPTY;
		if (fits) offset += need;

		if (offsets.get(scale.id) !== base || versions.get(scale.id) !== scale.slotVersion) {
			if (fits) {
				// A scale with no driver offers neither half, and gets its settled
				// table in both — the shader's mix is then an identity for it, which
				// is cheaper than branching on whether a scale animates.
				const from = scale.slotFrom ?? table;
				const to = scale.slotTo ?? table;
				buffer[base] = table.length;
				buffer[base + 1] = scale.t ?? 1;
				buffer.set(from, base + 2);
				bufferTo[base] = table.length;
				bufferTo[base + 1] = scale.t ?? 1;
				bufferTo.set(to, base + 2);
				bases.fill(base, base, base + need);
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
