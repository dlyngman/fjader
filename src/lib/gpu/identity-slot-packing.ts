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
 * `[count, slot0 … slot(count-1), act0 … act(count-1)]`. The count header makes
 * each block self-describing, so the shader rejects an id past this scale's end
 * instead of reading into the next scale's slots — ids and the slot table can
 * disagree transiently while a dim appends — and it is also how the shader finds
 * the activity half, at `base + 1 + count`, with no second base to store.
 *
 * The ACTIVITY half says how selected each id is (1 active, 0 inactive; see
 * ActivityTable). It is always allocated, all 1 for a scale without a table, so
 * every block has the same shape and an activity read never lands in the next
 * block. Each half has its own version and its own `t`: a click rewrites and
 * resolves only the activity half, a reorder only the slot half, as long as
 * `count` is unchanged. The activity half starts after the slots, so a change of
 * `count` moves it and rewrites it too.
 *
 * TWO buffers share one set of offsets: `from` is where each id's current
 * transition started and `to` where it is going, and the resolve kernel writes
 * `mix(from[id], to[id], t)` into a third that the render stages read. Two
 * bindings rather than two runs in one buffer, so the halves line up at the
 * same base and one dispatch per block covers both.
 *
 * `t` is not in the buffers. It is PER HALF of each scale — the slots have the
 * scale's data clock and the activity its selection clock — and reaches the
 * kernel as an immediate on that half's dispatch, so a frame where only `t`
 * moved uploads nothing at all.
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
 *
 * Each scale takes `1 + 2 · count`: a header, the slots and the activity half.
 * Category counts are usually tens to hundreds, so the doubling for the
 * activity half is accepted rather than worked around.
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

/**
 * One scale's activity as the packer reads it: 1 active, 0 inactive, as the two
 * ends of a fade. ActivityTable has this shape.
 *
 * Its length is not trusted: the packer takes `count` from the slots and pads
 * with 1 or truncates, so a moment where the two disagree (a dim append reaching
 * one before the other) cannot shift the activity half onto the wrong ids.
 */
export interface ActivitySource {
	readonly from: Float32Array;
	readonly to: Float32Array;
	/** 0 -> from, 1 -> to. Its own clock, not the slots'. */
	readonly t: number;
	/** Bumped whenever `from` or `to` change. */
	readonly version: number;
}

/**
 * A scale with a slot table, as the packer needs it: its slots and, beside
 * them, its selection fade for the block's activity half. Absent for a scale
 * without a selection table, whose activity half is then all 1.
 */
export interface IdentitySlotScale {
	id: string;
	slots: SlotSource;
	activity?: ActivitySource | null;
}

/**
 * One range to resolve this frame: `length` floats from `base`, at `t`. A
 * scale's slot half and activity half are separate ranges, since each has its
 * own `t`.
 *
 * The count header is inside the slot range rather than skipped: it holds the
 * same value in both buffers, so mixing it returns it, and the render stages
 * read their bound from the resolved copy. Pooled in the state and overwritten
 * by the next pack.
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
	 * The `t` each scale's halves were last resolved at, `[slots, activity]`, so a
	 * still frame dispatches nothing and an animating one dispatches only the
	 * halves that are moving.
	 *
	 * A typed array per scale, created once, rather than a `Map<string, number>`:
	 * a fractional `t` stored as a Map value is boxed, which allocated on every
	 * frame of every transition.
	 */
	resolvedT: Map<string, Float64Array>;
	/** Last packed activity version per scale; -1 for a scale without a table. */
	activityVersions: Map<string, number>;
	/** Last packed count per scale: a change moves the activity half. */
	counts: Map<string, number>;
	/**
	 * The pass each scale was last seen in, for the eviction sweep.
	 *
	 * A pass counter rather than a Set cleared every pack: clearing a Set
	 * allocates a new table in V8, which made every frame allocate ~370 bytes
	 * (measured, 20 scales) even when nothing moved. Re-setting an existing key
	 * to a small integer allocates nothing.
	 */
	seenPass: Map<string, number>;
	/** The current pass, a small integer that wraps. */
	pass: number;
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
		activityVersions: new Map(),
		counts: new Map(),
		seenPass: new Map(),
		pass: 0,
		result: { uploadStart: 0, uploadEnd: 0, resolves: [], resolveCount: 0 }
	};
}

/**
 * Assign every scale a base, write the halves that moved, and list what to
 * upload and what to resolve.
 *
 * | Half | Rewritten when | Resolved when |
 * |---|---|---|
 * | Slots | base or slot version changed | rewritten, or slot `t` changed |
 * | Activity | base, count or activity version changed | rewritten, or activity `t` changed |
 *
 * A half that is rewritten must be resolved even when its `t` did not move: the
 * render stages read the resolved buffer, not these. A parked scale is neither
 * rewritten nor resolved: it has no block, and the empty block it points at is
 * never written.
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
	const { activityVersions, counts, seenPass } = state;
	const capacity = buffer.length;
	const resolves = result.resolves;

	// Index 0 is the permanent empty block; real blocks start after it.
	let offset = 1;
	let uploadStart = capacity;
	let uploadEnd = 0;
	let resolveCount = 0;
	// Runs every frame, so nothing here may allocate on a frame where no scale
	// appeared: the pass stamp replaces a Set cleared every pack. Kept a small
	// integer (a Smi) so storing it never boxes.
	const pass = (state.pass = state.pass >= 0x3fffffff ? 1 : state.pass + 1);
	let seenCount = 0;

	for (let i = 0; i < scales.length; i++) {
		const scale = scales[i];
		if (seenPass.get(scale.id) !== pass) {
			seenPass.set(scale.id, pass);
			seenCount++;
		}

		const slots = scale.slots;
		const count = slots.count;
		const activity = scale.activity ?? null;
		// A header, the slots, and the activity half.
		const need = 1 + 2 * count;
		const fits = offset + need <= capacity;
		const base = fits ? offset : IDENTITY_SLOT_EMPTY;
		if (fits) offset += need;
		const activityBase = base + 1 + count;

		const version = slots.version;
		const activityVersion = activity ? activity.version : -1;
		const baseMoved = offsets.get(scale.id) !== base;
		const slotsDirty = baseMoved || versions.get(scale.id) !== version;
		const activityDirty =
			baseMoved ||
			counts.get(scale.id) !== count ||
			activityVersions.get(scale.id) !== activityVersion;

		let slotsRewritten = false;
		let activityRewritten = false;
		if (slotsDirty || activityDirty) {
			if (fits) {
				if (slotsDirty) {
					buffer[base] = count;
					buffer.set(slots.from, base + 1);
					bufferTo[base] = count;
					bufferTo.set(slots.to, base + 1);
					if (base < uploadStart) uploadStart = base;
					if (activityBase > uploadEnd) uploadEnd = activityBase;
					slotsRewritten = true;
				}
				if (activityDirty) {
					writeActivity(buffer, bufferTo, activityBase, count, activity);
					if (activityBase < uploadStart) uploadStart = activityBase;
					if (base + need > uploadEnd) uploadEnd = base + need;
					activityRewritten = true;
				}
			} else if (slotsDirty) {
				// Warn on the transition only — the caller runs this every frame.
				console.warn(
					`[GPUCoordinator] Identity slot capacity (${capacity}) exhausted; ` +
						`scale "${scale.id}" (${count} ids) will not render.`
				);
			}
			offsets.set(scale.id, base);
			versions.set(scale.id, version);
			counts.set(scale.id, count);
			activityVersions.set(scale.id, activityVersion);
		}
		// No break: a later scale with a smaller table may still fit, and one
		// that does not is parked on the empty block rather than left holding a
		// base that now belongs to someone else.

		if (!fits) continue;

		// Created once per scale; NaN so the first comparison always differs.
		let lastT = resolvedT.get(scale.id);
		if (!lastT) {
			lastT = new Float64Array(2).fill(NaN);
			resolvedT.set(scale.id, lastT);
		}

		const t = slots.t;
		if (slotsRewritten || lastT[0] !== t) {
			lastT[0] = t;
			const block = (resolves[resolveCount++] ??= { base: 0, length: 0, t: 0 });
			block.base = base;
			block.length = 1 + count;
			block.t = t;
		}

		// An empty activity half has nothing to resolve.
		const at = activity ? activity.t : 1;
		if (count > 0 && (activityRewritten || lastT[1] !== at)) {
			lastT[1] = at;
			const block = (resolves[resolveCount++] ??= { base: 0, length: 0, t: 0 });
			block.base = activityBase;
			block.length = count;
			block.t = at;
		}
	}

	// Drop entries for scales that have gone away, so a re-registered id cannot
	// inherit a base from a previous life. `offsets` is a superset of this pass's
	// scales by construction — every scale above is written — so comparing sizes
	// is a sound test for set equality and not just a cheap approximation of one.
	// The sweep allocates, but only on a frame where a scale went away.
	if (offsets.size !== seenCount) {
		for (const id of [...offsets.keys()]) {
			if (seenPass.get(id) !== pass) {
				offsets.delete(id);
				versions.delete(id);
				resolvedT.delete(id);
				activityVersions.delete(id);
				counts.delete(id);
				seenPass.delete(id);
			}
		}
	}

	result.uploadStart = uploadEnd > 0 ? uploadStart : 0;
	result.uploadEnd = uploadEnd;
	result.resolveCount = resolveCount;
	return result;
}

/**
 * Write a block's activity half: `count` floats from `start`, in both buffers.
 *
 * The length comes from the slots, not from the activity arrays: ids past their
 * end are fully active, and entries past `count` are dropped. A plain loop, so a
 * rewrite allocates nothing. With no table every id is active.
 */
function writeActivity(
	buffer: Float32Array,
	bufferTo: Float32Array,
	start: number,
	count: number,
	activity: ActivitySource | null
): void {
	const from = activity?.from;
	const to = activity?.to;
	const fromLen = from ? from.length : 0;
	const toLen = to ? to.length : 0;
	for (let i = 0; i < count; i++) {
		buffer[start + i] = i < fromLen ? from![i] : 1;
		bufferTo[start + i] = i < toLen ? to![i] : 1;
	}
}
