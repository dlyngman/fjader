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
 * LAYOUT. Index 0 is a permanent empty block `[0, 0, 0]`. Then one SLOT
 * block per scale, then one ACTIVITY block per live categorical field:
 *
 *   scale block: [count, actRef, n, slot0 … slot(count-1)]
 *   field block: [group 0: act0 … act(n-1), group 1: act0 … act(n-1), …]
 *
 * Slots come first so that when the buffer runs out it is activity that is
 * lost (a mark draws undimmed), never an axis. A field has a block while a
 * scale draws it, selected on or not, and a field no chart draws any more
 * frees its space. Tying the block to the selection instead saved that space
 * on pages with nothing selected, but every select and clear then moved the
 * block and rewrote every scale block pointing at it, slots included:
 * measured at about 105000 floats uploaded per click for 20 scales on a
 * 5000-category field, against 5000 when the block stays.
 *
 * KNOWN LIMIT: a field block that does not fit leaves a selection on that
 * field doing nothing for the marks that dim by it. Routing (the mark's reads,
 * see activity-reads.ts) still sends them to dim rather than filter, and their
 * shader finds no activity. Routing does not ask the packer whether a field
 * got a block, which would tie the query layer to the GPU layout; the packer
 * warns instead, on load. It takes fields of tens of thousands of ids across
 * several groups to reach. A buffer that grows on demand is the real fix.
 *
 * A scale block's header says how many ids its slots cover (`count`), where its
 * field's activity block starts (`actRef`) and how many ids that block covers
 * (`n`). The count is what makes a block self-describing, so the shader rejects
 * an id past this scale's end instead of reading into the next scale's slots —
 * ids and the slot table can disagree transiently while a dim appends.
 *
 * ACTIVITY says how selected each id is in each filter group (1 active, 0
 * inactive; see FieldActivity). It belongs to the field, not to the scale:
 * every scale on one field reads the same block, a mark choosing its group's
 * half by its group index. So a click rewrites and resolves one half of one
 * field block, however many scales draw that field. The header comes first so
 * the shader finds `actRef` and `n` without reading `count`: the activity read
 * is two dependent loads, as it was when the activity sat after the slots. No
 * mark holds `actRef`; the packer writes it in the same pass that moves the
 * field block, so it cannot go stale. A scale with no field to dim points at
 * the empty block, where `n` is 0 and every id is active.
 *
 * TWO buffers share one set of offsets: `from` is where each id's current
 * transition started and `to` where it is going, and the resolve kernel writes
 * `mix(from[id], to[id], t)` into a third that the render stages read. Two
 * bindings rather than two runs in one buffer, so the halves line up at the
 * same base and one dispatch per block covers both.
 *
 * `t` is not in the buffers. It is per scale (its data clock) and per field
 * half (that group's selection clock), and reaches the kernel as an immediate
 * on that range's dispatch, so a frame where only `t` moved uploads nothing.
 */

/**
 * Floats GLOBALLY across every band and point scale on the page, headers
 * included, and every live field's activity.
 *
 * No longer a binding limit: the tables are storage buffers, bound only to the
 * resolve pass, and the render stages read one resolved storage buffer. Making
 * the allocation grow on demand (recreate the buffers, rebuild the bind groups)
 * is what would retire it.
 *
 * Each scale takes `3 + count`; each live field `n × groups`. 65536 fits a
 * 5000-category field selected on across 3 groups (15000) with its scales
 * (about 5000 each) several times over. It costs 256 KB per buffer, 768 KB for
 * the three; the resolve pass dispatches per block, sized by the block, so a
 * larger buffer costs no GPU time.
 */
export const IDENTITY_SLOT_CAPACITY = 65536;

/**
 * Base of the permanent empty block `[0, 0, 0]`. A scale that cannot be placed
 * points here, so every lookup finds count 0 and discards, and every activity
 * read finds n 0 and is fully active. Pointing it at a stale base instead left
 * the scale rendering, from another scale's slots.
 */
export const IDENTITY_SLOT_EMPTY = 0;

/**
 * The group index of a mark that reads no selection activity: identityActivity
 * returns fully active for it before computing any offset, so it never indexes
 * past a field block. A mark whose selectionResponse is 'filter' gets it: in
 * the chart holding a selection's control it keeps its data (the chart skips
 * its own selection), and this keeps it from dimming there too.
 */
export const NO_GROUP = 0xffffffff;

/** Floats before a scale block's slots: count, actRef, n. */
export const IDENTITY_SLOT_HEADER = 3;

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
 * One group's activity on one field as the packer reads it: 1 active, 0
 * inactive, as the two ends of a fade. ActivityTable has this shape.
 *
 * Its length is not trusted: the packer takes `n` from the field and pads with
 * 1 or truncates, so a moment where the two disagree cannot shift the half onto
 * the wrong ids.
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
 * A scale with a slot table, as the packer needs it: its slots, and the identity
 * key of its field, whose activity block its header points at. No field (or a
 * field with no activity block) points it at the empty block.
 */
export interface IdentitySlotScale {
	id: string;
	slots: SlotSource;
	field?: string | null;
}

/**
 * A categorical field's selection activity, as the packer reads it: one fade
 * per filter group, over `count` ids. FieldActivity has this shape.
 */
export interface ActivityField {
	readonly key: string;
	/** Ids covered: the block's `n`. */
	readonly count: number;
	/** Group `index`'s fade, or null when that group never selected here (all 1). */
	fadeOf(index: number): ActivitySource | null;
}

/**
 * One range to resolve this frame: `length` floats from `base`, at `t`. A
 * scale's slots and each group's half of a field block are separate ranges,
 * since each has its own `t`.
 *
 * The header is inside the slot range rather than skipped: it holds the same
 * values in both buffers, so the kernel returns them exactly, and the render
 * stages read it from the resolved copy. Pooled in the state and overwritten by
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
	/** Last packed count per scale. */
	counts: Map<string, number>;
	/** Last packed actRef and n per scale: a field block that moved rewrites the header. */
	refs: Map<string, number>;
	ns: Map<string, number>;
	/**
	 * The `t` each scale's slots were last resolved at, so a still frame
	 * dispatches nothing. A typed array per scale, created once, rather than a
	 * `Map<string, number>`: a fractional `t` stored as a Map value is boxed,
	 * which allocated on every frame of every transition.
	 */
	resolvedT: Map<string, Float64Array>;
	/** Per field: its block's base, `n` and the group count it was packed for. */
	fieldBases: Map<string, number>;
	fieldNs: Map<string, number>;
	fieldGroups: Map<string, number>;
	/** Per field, per group: the fade version last written and the `t` last resolved. */
	fieldVersions: Map<string, Float64Array>;
	fieldT: Map<string, Float64Array>;
	/** The pass a scale last drew each field in: a field no scale draws gets no block. */
	fieldSeen: Map<string, number>;
	/** Fields whose block did not fit, warned about once until they fit again. */
	warnedFields: Set<string>;
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
	// The permanent empty block: count 0, actRef 0, n 0. Never -1: u32(-1.0)
	// is undefined in WGSL.
	buffer.fill(0, IDENTITY_SLOT_EMPTY, IDENTITY_SLOT_EMPTY + IDENTITY_SLOT_HEADER);
	bufferTo.fill(0, IDENTITY_SLOT_EMPTY, IDENTITY_SLOT_EMPTY + IDENTITY_SLOT_HEADER);
	return {
		buffer,
		bufferTo,
		offsets: new Map(),
		versions: new Map(),
		counts: new Map(),
		refs: new Map(),
		ns: new Map(),
		resolvedT: new Map(),
		fieldBases: new Map(),
		fieldNs: new Map(),
		fieldGroups: new Map(),
		fieldVersions: new Map(),
		fieldT: new Map(),
		fieldSeen: new Map(),
		warnedFields: new Set(),
		seenPass: new Map(),
		pass: 0,
		result: { uploadStart: 0, uploadEnd: 0, resolves: [], resolveCount: 0 }
	};
}

/**
 * Assign every field and scale a base, write the ranges that moved, and list
 * what to upload and what to resolve.
 *
 * | Range | Rewritten when | Resolved when |
 * |---|---|---|
 * | A field's group half | its base, `n` or the group count moved, or that group's fade version | rewritten, or that fade's `t` moved |
 * | A scale's header + slots | its base, slot version, or its field block's base or `n` moved | rewritten, or slot `t` moved |
 *
 * A range that is rewritten must be resolved even when its `t` did not move:
 * the render stages read the resolved buffer, not these. A parked scale is
 * neither rewritten nor resolved: it has no block, and the empty block it
 * points at is never written.
 *
 * Offsets are recomputed on every call because a block appearing or
 * disappearing shifts every block after it. That is a running sum over a
 * handful of blocks, and the alternative — a free list — would have to survive
 * a block changing size, which happens whenever a dim appends. A field block
 * that moves rewrites the headers pointing at it in the same pass.
 *
 * `fields` and `groups` default to none, which packs the slots alone.
 */
export function packIdentitySlots(
	scales: readonly IdentitySlotScale[],
	state: IdentitySlotState,
	fields: readonly ActivityField[] = NO_FIELDS,
	groups: number = 0
): PackResult {
	const { buffer, bufferTo, offsets, versions, counts, refs, ns, resolvedT, result } = state;
	const { fieldBases, fieldNs, fieldGroups, fieldVersions, fieldT, seenPass } = state;
	const { fieldSeen, warnedFields } = state;
	const capacity = buffer.length;
	const resolves = result.resolves;

	// The permanent empty block comes first; real blocks start after it.
	let offset = IDENTITY_SLOT_EMPTY + IDENTITY_SLOT_HEADER;
	let uploadStart = capacity;
	let uploadEnd = 0;
	let resolveCount = 0;
	// Runs every frame, so nothing here may allocate on a frame where no block
	// appeared: the pass stamp replaces a Set cleared every pack. Kept a small
	// integer (a Smi) so storing it never boxes.
	const pass = (state.pass = state.pass >= 0x3fffffff ? 1 : state.pass + 1);
	let seenCount = 0;

	// --- Where the scale blocks end, and which fields a scale draws ---
	// The same running sum the scale loop below makes, so the field blocks can
	// be placed after the scales before the scale headers are written.
	let fieldOffset = offset;
	for (let i = 0; i < scales.length; i++) {
		const need = IDENTITY_SLOT_HEADER + scales[i].slots.count;
		if (fieldOffset + need <= capacity) fieldOffset += need;
		const key = scales[i].field;
		if (key) fieldSeen.set(key, pass);
	}

	// --- Field blocks: one run per group, after the scales ---
	for (let f = 0; f < fields.length; f++) {
		const field = fields[f];
		const key = field.key;
		const count = field.count;
		const live = fieldSeen.get(key) === pass;
		const need = live ? count * groups : 0;
		const fits = need > 0 && fieldOffset + need <= capacity;
		const base = fits ? fieldOffset : IDENTITY_SLOT_EMPTY;
		const n = fits ? count : 0;
		if (fits) fieldOffset += need;
		if (need > 0 && !fits) {
			// On the transition only: this runs every frame.
			if (!warnedFields.has(key)) {
				warnedFields.add(key);
				console.warn(
					`[GPUCoordinator] Identity slot capacity (${capacity}) exhausted; ` +
						`"${key}" (${count} ids × ${groups} groups) will not dim: a selection on it ` +
						`leaves the marks that dim by it unchanged.`
				);
			}
		} else if (fits && warnedFields.size > 0) {
			warnedFields.delete(key);
		}

		const moved =
			fieldBases.get(key) !== base || fieldNs.get(key) !== n || fieldGroups.get(key) !== groups;
		let written = fieldVersions.get(key);
		let lastT = fieldT.get(key);
		if (!written || written.length !== groups) {
			// Created when a field first packs or the page gains a group: rare.
			written = new Float64Array(groups).fill(NaN);
			lastT = new Float64Array(groups).fill(NaN);
			fieldVersions.set(key, written);
			fieldT.set(key, lastT!);
		}
		if (moved) {
			fieldBases.set(key, base);
			fieldNs.set(key, n);
			fieldGroups.set(key, groups);
		}
		if (!fits) continue;

		for (let g = 0; g < groups; g++) {
			const fade = field.fadeOf(g);
			const version = fade ? fade.version : -1;
			const start = base + n * g;
			let rewritten = false;
			if (moved || written[g] !== version) {
				writeActivity(buffer, bufferTo, start, n, fade);
				written[g] = version;
				if (start < uploadStart) uploadStart = start;
				if (start + n > uploadEnd) uploadEnd = start + n;
				rewritten = true;
			}
			const t = fade ? fade.t : 1;
			if (rewritten || lastT![g] !== t) {
				lastT![g] = t;
				const block = (resolves[resolveCount++] ??= { base: 0, length: 0, t: 0 });
				block.base = start;
				block.length = n;
				block.t = t;
			}
		}
	}

	// --- Scale blocks: [count, actRef, n, slots…] ---
	for (let i = 0; i < scales.length; i++) {
		const scale = scales[i];
		if (seenPass.get(scale.id) !== pass) {
			seenPass.set(scale.id, pass);
			seenCount++;
		}

		const slots = scale.slots;
		const count = slots.count;
		const need = IDENTITY_SLOT_HEADER + count;
		const fits = offset + need <= capacity;
		const base = fits ? offset : IDENTITY_SLOT_EMPTY;
		if (fits) offset += need;

		const fieldKey = scale.field;
		const ref = fieldKey ? (fieldBases.get(fieldKey) ?? IDENTITY_SLOT_EMPTY) : IDENTITY_SLOT_EMPTY;
		const n = ref === IDENTITY_SLOT_EMPTY ? 0 : (fieldNs.get(fieldKey!) ?? 0);

		const version = slots.version;
		const dirty =
			offsets.get(scale.id) !== base ||
			versions.get(scale.id) !== version ||
			counts.get(scale.id) !== count ||
			refs.get(scale.id) !== ref ||
			ns.get(scale.id) !== n;

		let rewritten = false;
		if (dirty) {
			if (fits) {
				buffer[base] = count;
				buffer[base + 1] = ref;
				buffer[base + 2] = n;
				buffer.set(slots.from, base + IDENTITY_SLOT_HEADER);
				bufferTo[base] = count;
				bufferTo[base + 1] = ref;
				bufferTo[base + 2] = n;
				bufferTo.set(slots.to, base + IDENTITY_SLOT_HEADER);
				if (base < uploadStart) uploadStart = base;
				if (base + need > uploadEnd) uploadEnd = base + need;
				rewritten = true;
			} else if (offsets.get(scale.id) !== base || versions.get(scale.id) !== version) {
				// Warn on the transition only — the caller runs this every frame.
				console.warn(
					`[GPUCoordinator] Identity slot capacity (${capacity}) exhausted; ` +
						`scale "${scale.id}" (${count} ids) will not render.`
				);
			}
			offsets.set(scale.id, base);
			versions.set(scale.id, version);
			counts.set(scale.id, count);
			refs.set(scale.id, ref);
			ns.set(scale.id, n);
		}
		// No break: a later scale with a smaller table may still fit, and one
		// that does not is parked on the empty block rather than left holding a
		// base that now belongs to someone else.

		if (!fits) continue;

		// Created once per scale; NaN so the first comparison always differs.
		let lastT = resolvedT.get(scale.id);
		if (!lastT) {
			lastT = new Float64Array(1).fill(NaN);
			resolvedT.set(scale.id, lastT);
		}

		const t = slots.t;
		if (rewritten || lastT[0] !== t) {
			lastT[0] = t;
			const block = (resolves[resolveCount++] ??= { base: 0, length: 0, t: 0 });
			block.base = base;
			block.length = need;
			block.t = t;
		}
	}

	// Drop entries for scales that have gone away, so a re-registered id cannot
	// inherit a base from a previous life. `offsets` is a superset of this pass's
	// scales by construction — every scale above is written — so comparing sizes
	// is a sound test for set equality and not just a cheap approximation of one.
	// The sweep allocates, but only on a frame where a scale went away. Fields
	// are not swept: the registry keeps every field it created.
	if (offsets.size !== seenCount) {
		for (const id of [...offsets.keys()]) {
			if (seenPass.get(id) !== pass) {
				offsets.delete(id);
				versions.delete(id);
				counts.delete(id);
				refs.delete(id);
				ns.delete(id);
				resolvedT.delete(id);
				seenPass.delete(id);
			}
		}
	}

	result.uploadStart = uploadEnd > 0 ? uploadStart : 0;
	result.uploadEnd = uploadEnd;
	result.resolveCount = resolveCount;
	return result;
}

const NO_FIELDS: readonly ActivityField[] = [];

/**
 * Write one group's half of a field block: `count` floats from `start`, in
 * both buffers.
 *
 * The length is the block's `n`, not the fade's: ids past the fade's end are
 * fully active, and entries past `n` are dropped. A plain loop, so a rewrite
 * allocates nothing. With no fade every id is active.
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
