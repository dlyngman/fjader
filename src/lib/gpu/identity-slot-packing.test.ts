import { describe, it, expect, vi } from 'vitest';
import {
	IDENTITY_SLOT_EMPTY,
	IDENTITY_SLOT_HEADER,
	createIdentitySlotState,
	packIdentitySlots,
	type ActivityField,
	type IdentitySlotScale,
	type IdentitySlotState
} from './identity-slot-packing';
import { resolveReference } from './ResolveShader';
import { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import { ActivityTable } from '$lib/scales/ActivityTable';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';

/** A scale whose slots travel from `from` to `to`, `t` of the way. */
function travelling(
	id: string,
	from: number[],
	to: number[],
	t: number,
	version = 1
): IdentitySlotScale {
	return {
		id,
		slots: {
			count: from.length,
			from: Float32Array.from(from),
			to: Float32Array.from(to),
			t,
			version
		}
	};
}

/** A settled scale whose slot table is the given permutation. */
function scale(id: string, slots: number[], version = 1): IdentitySlotScale {
	return travelling(id, slots, slots, 1, version);
}

/** Read one scale's block back the way the shader's identitySlot() does. */
function readBlock(buffer: Float32Array, base: number) {
	const count = buffer[base];
	const start = base + IDENTITY_SLOT_HEADER;
	return { count, slots: Array.from(buffer.slice(start, start + count)) };
}

/**
 * Run a pack's dispatch list through the kernel's JS twin, into `resolved` —
 * exactly what #encodeSlotResolve encodes. `resolved` persists across packs the
 * way the GPU buffer does, so a block nobody dispatched keeps its old values.
 */
function applyResolves(state: IdentitySlotState, resolved: Float32Array): Float32Array {
	const { resolves, resolveCount } = state.result;
	for (let i = 0; i < resolveCount; i++) {
		const { base, length, t } = resolves[i];
		resolveReference(state.buffer, state.bufferTo, t, length, resolved, base);
	}
	return resolved;
}

/** Which bases this pack dispatches, in order. */
function dispatched(state: IdentitySlotState): number[] {
	return state.result.resolves.slice(0, state.result.resolveCount).map((b) => b.base);
}

describe('packIdentitySlots layout', () => {
	it('reserves index 0 as a permanent empty block', () => {
		const state = createIdentitySlotState(64);
		// Before anything is packed, and after: a scale parked here must find
		// count 0 and discard, which is the whole point of the fallback.
		// It is [count 0, actRef 0, n 0]: never -1, which u32() cannot read.
		expect(Array.from(state.buffer.slice(0, 3))).toEqual([0, 0, 0]);
		packIdentitySlots([scale('a', [0, 1, 2])], state);
		expect(Array.from(state.buffer.slice(0, 3))).toEqual([0, 0, 0]);
		expect(Array.from(state.bufferTo.slice(0, 3))).toEqual([0, 0, 0]);
	});

	it('writes a count header before each block', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [2, 0, 1])], state);

		const base = state.offsets.get('a')!;
		expect(base).toBe(3); // straight after the empty block
		expect(readBlock(state.buffer, base)).toEqual({ count: 3, slots: [2, 0, 1] });
	});

	it('lays consecutive scales end to end with no overlap', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1]), scale('b', [1, 0, 2]), scale('c', [0])], state);

		const [a, b, c] = ['a', 'b', 'c'].map((id) => state.offsets.get(id)!);
		// Header + slots: 3 + (3+2) = 8, 8 + (3+3) = 14
		expect([a, b, c]).toEqual([3, 8, 14]);
		expect(readBlock(state.buffer, a)).toEqual({ count: 2, slots: [0, 1] });
		expect(readBlock(state.buffer, b)).toEqual({ count: 3, slots: [1, 0, 2] });
		expect(readBlock(state.buffer, c)).toEqual({ count: 1, slots: [0] });
	});

	it('uploads only the range that was rewritten', () => {
		// One small scale reordering must not re-upload its neighbours' tables.
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1, 2, 3]), scale('b', [0, 1], 1)], state);
		// 3 empty + (3+4) + (3+2): the first pack writes both blocks.
		expect([state.result.uploadStart, state.result.uploadEnd]).toEqual([3, 15]);

		// A reorder of b: only its block.
		packIdentitySlots([scale('a', [0, 1, 2, 3]), scale('b', [1, 0], 2)], state);
		expect([state.result.uploadStart, state.result.uploadEnd]).toEqual([10, 15]);
	});

	it('preserves -1 for ids that are not displayed', () => {
		// A category filtered out by a transform, or one belonging to another
		// table on a shared scale. The shader discards both on the same test.
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, -1, 1])], state);
		expect(readBlock(state.buffer, state.offsets.get('a')!).slots).toEqual([0, -1, 1]);
	});
});

describe('packIdentitySlots transition state', () => {
	it('gives a scale with no driver the same table in both buffers', () => {
		// Ordinal colour and facet offer no from/to. Writing the settled table to
		// both makes the shader's mix an identity for them, which is cheaper than
		// branching in the shader on whether a scale animates.
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [2, 0, 1])], state);

		const base = state.offsets.get('a')!;
		expect(readBlock(state.buffer, base).slots).toEqual([2, 0, 1]);
		expect(readBlock(state.bufferTo, base).slots).toEqual([2, 0, 1]);
		// t = 1 means settled, so mix(from, to, 1) is `to` whatever from holds.
		const resolved = applyResolves(state, new Float32Array(64));
		expect(readBlock(resolved, base)).toEqual({ count: 3, slots: [2, 0, 1] });
	});

	it('writes from and to into their own buffers at the same base', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([travelling('a', [2, 1, 0], [0, 1, 2], 0.25)], state);

		const base = state.offsets.get('a')!;
		// One base serves both buffers — that is what lets p4 stay a single float.
		expect(readBlock(state.buffer, base)).toEqual({ count: 3, slots: [2, 1, 0] });
		expect(readBlock(state.bufferTo, base)).toEqual({ count: 3, slots: [0, 1, 2] });
		// t is not in either buffer: it goes to this block's dispatch.
		expect(state.result.resolves[0].t).toBe(0.25);
	});

	it('keeps the empty block empty in both buffers', () => {
		// A parked scale reads count 0 from whichever buffer the shader asks, so
		// both need the header — not just the one carrying `from`.
		const state = createIdentitySlotState(64);
		expect(state.buffer[IDENTITY_SLOT_EMPTY]).toBe(0);
		expect(state.bufferTo[IDENTITY_SLOT_EMPTY]).toBe(0);
	});

	it('counts the header against capacity, not just the slots', () => {
		// Three floats of header per block, so a budget that fits the slots alone
		// may not fit the block.
		const state = createIdentitySlotState(12);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// 3 empty + (3 header + 4 slots) = 10; a 1-id scale needs 4 more, 2 remain.
		packIdentitySlots([scale('a', [0, 1, 2, 3]), scale('b', [0])], state);
		expect(state.offsets.get('a')).toBe(3);
		expect(state.offsets.get('b')).toBe(IDENTITY_SLOT_EMPTY);
		warn.mockRestore();
	});
});

describe('packIdentitySlots dirty tracking', () => {
	it('uploads on first pack and nothing when nothing moved', () => {
		const state = createIdentitySlotState(64);
		const scales = [scale('a', [0, 1]), scale('b', [0])];

		expect(packIdentitySlots(scales, state).uploadEnd).toBeGreaterThan(0);
		// A static chart must cost no writeBuffer, which is the only reason this
		// function returns a range rather than always uploading.
		expect(packIdentitySlots(scales, state).uploadEnd).toBe(0);
	});

	it('is dirty when a slot table is rebuilt', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1, 2], 1)], state);

		// A reorder: same length, same base, new contents and a bumped version.
		const { uploadEnd } = packIdentitySlots([scale('a', [2, 1, 0], 2)], state);
		expect(uploadEnd).toBeGreaterThan(0);
		expect(readBlock(state.buffer, state.offsets.get('a')!).slots).toEqual([2, 1, 0]);
	});

	it('uploads and resolves nothing when a trailing scale goes', () => {
		// Dropping the LAST scale moves nobody's base and bumps nobody's version.
		// Its floats are left behind in the buffers, unread: nothing points there.
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1]), scale('b', [0])], state);

		const { uploadEnd, resolveCount } = packIdentitySlots([scale('a', [0, 1])], state);

		expect(uploadEnd).toBe(0);
		expect(resolveCount).toBe(0);
	});

	it('re-packs a scale whose base shifted even if its version did not', () => {
		// The reason bases are compared as well as versions. A scale inserted
		// ahead of it moves it; its own table never changed, so version alone
		// would leave it pointing at a base holding someone else's slots.
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1])], state);
		const before = state.offsets.get('a')!;

		packIdentitySlots([scale('big', [0, 1, 2, 3, 4]), scale('a', [0, 1])], state);
		const after = state.offsets.get('a')!;

		expect(after).not.toBe(before);
		expect(readBlock(state.buffer, after)).toEqual({ count: 2, slots: [0, 1] });
	});
});

describe('packIdentitySlots capacity', () => {
	it('parks a scale that does not fit on the empty block', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const state = createIdentitySlotState(10);
		// 3 empty + (3+4) = 10 used; the next needs 7 and none remain.
		packIdentitySlots([scale('a', [0, 1, 2, 3]), scale('b', [0, 1, 2, 3])], state);

		expect(state.offsets.get('a')).toBe(3);
		expect(state.offsets.get('b')).toBe(IDENTITY_SLOT_EMPTY);
		// Parked, not merely unwritten: a lookup there finds count 0 and
		// discards, rather than reading scale "a"'s slots.
		expect(state.buffer[IDENTITY_SLOT_EMPTY]).toBe(0);
		warn.mockRestore();
	});

	it('still places a later scale small enough to fit', () => {
		// The reason the loop does not break on the first scale that overflows.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const state = createIdentitySlotState(14);
		packIdentitySlots(
			[scale('a', [0, 1, 2, 3]), scale('huge', new Array(20).fill(0)), scale('c', [0])],
			state
		);

		expect(state.offsets.get('a')).toBe(3);
		expect(state.offsets.get('huge')).toBe(IDENTITY_SLOT_EMPTY);
		expect(state.offsets.get('c')).toBe(10);
		expect(readBlock(state.buffer, 10)).toEqual({ count: 1, slots: [0] });
		warn.mockRestore();
	});

	it('warns on the transition only, not every frame', () => {
		// The caller runs this per frame; a warning per frame is a log flood
		// that hides everything else.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const state = createIdentitySlotState(10);
		const scales = [scale('a', [0, 1, 2, 3]), scale('b', [0, 1, 2, 3])];

		packIdentitySlots(scales, state);
		packIdentitySlots(scales, state);
		packIdentitySlots(scales, state);

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('will not render');
		warn.mockRestore();
	});

	it('places a scale that fits again once room is freed', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const state = createIdentitySlotState(10);
		packIdentitySlots([scale('a', [0, 1, 2, 3]), scale('b', [0, 1, 2, 3])], state);
		expect(state.offsets.get('b')).toBe(IDENTITY_SLOT_EMPTY);

		// "a" unmounts; "b" should now be placed rather than left parked.
		packIdentitySlots([scale('b', [0, 1, 2, 3])], state);
		expect(state.offsets.get('b')).toBe(3);
		expect(readBlock(state.buffer, 3)).toEqual({ count: 4, slots: [0, 1, 2, 3] });
		warn.mockRestore();
	});
});

describe('packIdentitySlots eviction', () => {
	it('forgets a scale that has gone away', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1]), scale('b', [0])], state);

		packIdentitySlots([scale('a', [0, 1])], state);

		expect(state.offsets.has('b')).toBe(false);
		expect(state.versions.has('b')).toBe(false);
		expect(state.resolvedT.has('b')).toBe(false);
	});

	it('does not let a re-registered id inherit a base from a previous life', () => {
		// The failure this guards: "b" unmounts and remounts at a different
		// size. A stale base plus a matching version would skip the re-pack and
		// leave it reading whatever now occupies its old block.
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1, 2, 3, 4]), scale('b', [0, 1], 7)], state);
		const staleBase = state.offsets.get('b')!;

		packIdentitySlots([scale('a', [0, 1])], state); // b gone; a shrinks
		packIdentitySlots([scale('a', [0, 1]), scale('b', [2, 1, 0], 7)], state); // b back, same version

		const base = state.offsets.get('b')!;
		expect(base).not.toBe(staleBase);
		expect(readBlock(state.buffer, base)).toEqual({ count: 3, slots: [2, 1, 0] });
	});

	it('evicts when one scale is swapped for another in the same pass', () => {
		// offsets is a superset of seen by construction, so comparing sizes is a
		// sound equality test — this is the case that would break it if it were
		// merely a cheap approximation.
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1]), scale('b', [0])], state);

		packIdentitySlots([scale('a', [0, 1]), scale('c', [0])], state);

		expect([...state.offsets.keys()].sort()).toEqual(['a', 'c']);
	});

	it('handles every scale disappearing', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1])], state);

		const { uploadEnd, resolveCount } = packIdentitySlots([], state);

		expect(state.offsets.size).toBe(0);
		expect(state.versions.size).toBe(0);
		expect(state.resolvedT.size).toBe(0);
		// Nothing to write; p4 falls back to the empty block.
		expect(uploadEnd).toBe(0);
		expect(resolveCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// The shader's view, evaluated in JS against the packed buffers.
// ---------------------------------------------------------------------------

describe('what the shader reads back', () => {
	/**
	 * identitySlot(base, id) from ScaleTemplateSystem, in TypeScript, over the
	 * buffer this pack's dispatches resolved.
	 */
	function identitySlot(state: IdentitySlotState, base: number, id: number): number {
		const resolved = applyResolves(state, new Float32Array(state.buffer.length));
		const count = resolved[base];
		if (id >= count) return -1;
		return resolved[base + IDENTITY_SLOT_HEADER + id];
	}

	it('agrees with the scale about every id, mid-transition', () => {
		// The two halves of the design meet here: JS computes where an id is as
		// mix(from, to, t) and the resolve pass computes the same thing from the
		// same three numbers. If they drift, bars are in the wrong slots.
		const s = new BandScaleState('species', [], {
			gpuCoordinator: { addAnimatedSource: () => {}, removeAnimatedSource: () => {} }
		});
		s.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		s.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		s.updateDomainFromExtents();

		// Chinstrap(1) leaves: a real slot in both tables, -1 in slotTarget.
		s.addMark(['Adelie', 'Gentoo'], 'mark-1');
		s.updateDomainFromExtents();
		for (let i = 0; i < 15; i++) {
			s.slots.clock.step();
			s.slots.clock.updateRenderState(0);
		}

		const state = createIdentitySlotState(64);
		packIdentitySlots([{ id: s.id, slots: s.slots }], state);
		const base = state.offsets.get(s.id)!;

		const snapshot = s.slots.snapshot();
		for (let id = 0; id < 3; id++) {
			expect(identitySlot(state, base, id)).toBeCloseTo(snapshot[id], 5);
		}

		// And the leaver specifically: still on screen, past where it started,
		// heading for the far end rather than being discarded at < 0.
		const leaver = identitySlot(state, base, 1);
		expect(leaver).toBeGreaterThan(1);
		expect(leaver).toBeLessThanOrEqual(2);
	});

	it('discards an id the scale does not display, without a sentinel branch', () => {
		// -1 in both tables, so the mix returns -1 for any t. This is why the
		// shader has no special case.
		const state = createIdentitySlotState(64);
		packIdentitySlots([travelling('a', [0, -1, 1], [1, -1, 0], 0.5)], state);
		const base = state.offsets.get('a')!;
		expect(identitySlot(state, base, 1)).toBe(-1);
	});
});

// ---------------------------------------------------------------------------
// The resolve list — which blocks this frame dispatches, and at what t
// ---------------------------------------------------------------------------
//
// Each scale's block is its own dispatch, with its own t as an immediate. The
// list is what the coordinator encodes, so getting it wrong is either a block
// left at a stale position (listed too rarely) or work every frame for a still
// chart (listed too often). The first renders plausibly wrong, which is the
// failure class this module exists to prevent, so it is asserted.

describe('packIdentitySlots: the resolve list', () => {
	it('resolves every block on first pack, header included', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1, 2]), scale('b', [1, 0])], state);

		const { resolves, resolveCount } = state.result;
		expect(resolveCount).toBe(2);
		// Per scale: header + slots, one range.
		expect(resolves.slice(0, 2).map((b) => [b.base, b.length])).toEqual([
			[3, 6],
			[9, 5]
		]);
	});

	it('dispatches nothing on a still frame', () => {
		// A hover or a pan renders a frame; nothing moved, so nothing resolves.
		const state = createIdentitySlotState(64);
		const scales = [scale('a', [0, 1]), travelling('b', [0], [3], 0.5)];
		packIdentitySlots(scales, state);

		expect(packIdentitySlots(scales, state).resolveCount).toBe(0);
	});

	it('dispatches only the scale whose t moved', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1]), travelling('b', [0], [3], 0.25)], state);

		packIdentitySlots([scale('a', [0, 1]), travelling('b', [0], [3], 0.5)], state);

		expect(dispatched(state)).toEqual([state.offsets.get('b')]);
		expect(state.result.resolves[0].t).toBe(0.5);
	});

	it('gives each scale its OWN t', () => {
		// A shared t would pass every other test in this file. Two scales at
		// different points in their transitions is the case that separates "each
		// dispatch carries its own t" from "whichever t was set last" — and
		// reading a neighbour's t renders plausibly, at the wrong point in a
		// transition, which is the worst kind of wrong here.
		const state = createIdentitySlotState(64);
		packIdentitySlots([travelling('a', [0], [10], 0), travelling('b', [0], [10], 1)], state);
		const out = applyResolves(state, new Float32Array(64));

		expect(out[state.offsets.get('a')! + IDENTITY_SLOT_HEADER]).toBeCloseTo(0, 5);
		expect(out[state.offsets.get('b')! + IDENTITY_SLOT_HEADER]).toBeCloseTo(10, 5);
	});

	it('re-resolves a scale shifted by its neighbour, though its t did not move', () => {
		// 'b' moves because 'a' shrank. Its table and t are unchanged, but the
		// resolved buffer at its NEW base holds whatever was there before — 'a''s
		// old slots — until something dispatches over it.
		const state = createIdentitySlotState(64);
		const resolved = new Float32Array(64);
		packIdentitySlots([scale('a', [0, 1, 2, 3]), travelling('b', [0], [4], 0.5)], state);
		applyResolves(state, resolved);

		packIdentitySlots([scale('a', [0, 1], 2), travelling('b', [0], [4], 0.5)], state);
		applyResolves(state, resolved);

		const b = state.offsets.get('b')!;
		expect(dispatched(state)).toContain(b);
		expect(readBlock(resolved, b)).toEqual({ count: 1, slots: [2] });
	});

	it('never dispatches a parked scale', () => {
		// It points at the empty block, whose count of 0 is what makes every
		// lookup discard. Resolving over it would be harmless only by accident.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const state = createIdentitySlotState(10);
		packIdentitySlots([scale('a', [0, 1, 2, 3]), scale('b', [0, 1, 2, 3])], state);

		// a's block at 3; nothing for b.
		expect(dispatched(state)).toEqual([3]);
		expect(dispatched(state)).not.toContain(IDENTITY_SLOT_EMPTY);
		warn.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// The resolved buffer, against the vertex-stage mix it replaced
// ---------------------------------------------------------------------------

describe('resolving the packed blocks', () => {
	it('reproduces mix(from, to, t) for every id of every scale', () => {
		const state = createIdentitySlotState(64);
		const scales = [
			travelling('a', [0, 1, 2], [2, 0, 1], 0.4),
			travelling('b', [1, -1, 0], [0, -1, 1], 0.85)
		];
		packIdentitySlots(scales, state);
		const out = applyResolves(state, new Float32Array(64));

		for (const s of scales) {
			const base = state.offsets.get(s.id)!;
			// The header survives: count is identical in both halves, so mixing it
			// returns it. The shader still reads its bound from `resolved`.
			expect(out[base]).toBe(s.slots.count);
			for (let id = 0; id < s.slots.count; id++) {
				const a = s.slots.from[id];
				const b = s.slots.to[id];
				expect(out[base + IDENTITY_SLOT_HEADER + id]).toBeCloseTo(a + (b - a) * s.slots.t, 5);
			}
		}
	});

	it('leaves an undisplayed id at -1 without a branch', () => {
		// -1 in both halves for any t. This is why neither the kernel nor the
		// shader has a sentinel case.
		const state = createIdentitySlotState(64);
		packIdentitySlots([travelling('a', [0, -1, 1], [1, -1, 0], 0.5)], state);
		const out = applyResolves(state, new Float32Array(64));
		expect(out[state.offsets.get('a')! + IDENTITY_SLOT_HEADER + 1]).toBe(-1);
	});

	it('writes nothing outside the packed blocks', () => {
		// The empty block and the unused tail stay as they were, or a buffer
		// dump is full of values nothing put there.
		const state = createIdentitySlotState(64);
		packIdentitySlots([travelling('a', [0, 1], [0, 1], 1)], state);
		const out = applyResolves(state, new Float32Array(64).fill(999));
		expect(out[IDENTITY_SLOT_EMPTY]).toBe(999);
		// The block is 3..7 (three of header, two slots); 8 is past its end.
		expect(out[3]).toBe(2);
		expect(out[7]).toBe(1);
		expect(out[8]).toBe(999);
		expect(out[63]).toBe(999);
	});
});

// ---------------------------------------------------------------------------
// Activity: one block per field, one run per group, referenced from scale headers
// ---------------------------------------------------------------------------

/** A field whose group fades are given as [from, to, t, version], or null for none. */
function field(
	key: string,
	count: number,
	fades: Array<[number[], number[], number, number] | null>
): ActivityField {
	return {
		key,
		count,
		fadeOf: (g) => {
			const f = fades[g];
			return f
				? { from: Float32Array.from(f[0]), to: Float32Array.from(f[1]), t: f[2], version: f[3] }
				: null;
		}
	};
}

/** A settled scale on `key`. */
function on(key: string, id: string, slots: number[], version = 1): IdentitySlotScale {
	return { ...scale(id, slots, version), field: key };
}

/** identityActivity(base, group, id) from the shader, in TypeScript. */
function identityActivity(resolved: Float32Array, base: number, group: number, id: number) {
	const ref = resolved[base + 1];
	const n = resolved[base + 2];
	if (id >= n) return 1;
	return resolved[ref + n * group + id];
}

const resolvedOf = (state: IdentitySlotState) =>
	applyResolves(state, new Float32Array(state.buffer.length));

describe('packIdentitySlots: field activity blocks', () => {
	it('points every scale on a field at one block, read per group', () => {
		const state = createIdentitySlotState(64);
		const carrier = field('carrier', 3, [null, [[1, 0, 1], [1, 0, 1], 1, 1]]);
		packIdentitySlots(
			[on('carrier', 'colour', [0, 1, 2]), on('carrier', 'band', [2, 1, 0])],
			state,
			[carrier],
			2
		);

		const out = resolvedOf(state);
		const colour = state.offsets.get('colour')!;
		const band = state.offsets.get('band')!;
		// One field block, after the empty block: 3 ids × 2 groups.
		expect(out[colour + 1]).toBe(3);
		expect(out[band + 1]).toBe(3);
		expect(out[colour + 2]).toBe(3);
		// Group 0 has no selection here; group 1 dims id 1.
		expect([0, 1, 2].map((id) => identityActivity(out, colour, 0, id))).toEqual([1, 1, 1]);
		expect([0, 1, 2].map((id) => identityActivity(out, band, 1, id))).toEqual([1, 0, 1]);
		// The slots are still where the slot lookup reads them.
		expect(readBlock(out, band)).toEqual({ count: 3, slots: [2, 1, 0] });
	});

	it('points a scale without a field, or with an empty one, at the empty block', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots(
			[scale('plain', [0, 1]), on('none', 'empty', [0])],
			state,
			[field('none', 0, [])],
			1
		);
		const out = resolvedOf(state);
		for (const id of ['plain', 'empty']) {
			const base = state.offsets.get(id)!;
			expect([out[base + 1], out[base + 2]]).toEqual([IDENTITY_SLOT_EMPTY, 0]);
			expect(identityActivity(out, base, 0, 0)).toBe(1);
		}
		expect(identityActivity(out, IDENTITY_SLOT_EMPTY, 0, 0)).toBe(1);
	});

	it('answers 1 for an id past n', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots(
			[on('f', 'a', [0, 1, 2])],
			state,
			[field('f', 2, [[[0, 0], [0, 0], 1, 1]])],
			1
		);
		const out = resolvedOf(state);
		const base = state.offsets.get('a')!;
		expect([0, 1, 2].map((id) => identityActivity(out, base, 0, id))).toEqual([0, 0, 1]);
	});

	it('rewrites and resolves only the clicked group, uploading only its run', () => {
		const state = createIdentitySlotState(64);
		const fades: Array<[number[], number[], number, number] | null> = [
			[[1, 1], [1, 1], 1, 1],
			[[1, 1], [1, 1], 1, 1]
		];
		const f = field('f', 2, fades);
		const scales = [on('f', 'a', [0, 1]), on('f', 'b', [1, 0])];
		packIdentitySlots(scales, state, [f], 2);

		fades[1] = [[1, 1], [0, 1], 0, 2];
		packIdentitySlots(scales, state, [f], 2);
		// Group 1's run starts after group 0's: 3 + 2.
		expect(dispatched(state)).toEqual([5]);
		expect([state.result.uploadStart, state.result.uploadEnd]).toEqual([5, 7]);
	});

	it('dispatches only the fading run while only its t moves, uploading nothing', () => {
		const state = createIdentitySlotState(64);
		const fades: Array<[number[], number[], number, number] | null> = [[[1, 1], [0, 1], 0.2, 1]];
		const f = field('f', 2, fades);
		// Persists across packs, as the GPU buffer does.
		const resolved = new Float32Array(64);
		packIdentitySlots([on('f', 'a', [0, 1])], state, [f], 1);
		applyResolves(state, resolved);
		fades[0] = [[1, 1], [0, 1], 0.6, 1];
		packIdentitySlots([on('f', 'a', [0, 1])], state, [f], 1);
		expect(state.result.uploadEnd).toBe(0);
		expect(dispatched(state)).toEqual([3]);
		expect(state.result.resolves[0].t).toBe(0.6);
		expect(
			identityActivity(applyResolves(state, resolved), state.offsets.get('a')!, 0, 0)
		).toBeCloseTo(0.4, 5);
	});

	it('dispatches nothing on a still frame', () => {
		const state = createIdentitySlotState(64);
		const f = field('f', 2, [[[1, 0], [1, 0], 1, 1]]);
		packIdentitySlots([on('f', 'a', [0, 1])], state, [f], 1);
		packIdentitySlots([on('f', 'a', [0, 1])], state, [f], 1);
		expect(state.result.resolveCount).toBe(0);
		expect(state.result.uploadEnd).toBe(0);
	});

	it('rewrites the header of every scale on a field whose block moved', () => {
		const state = createIdentitySlotState(64);
		const g = field('g', 2, [null]);
		const scales = [on('g', 'a', [0, 1]), on('g', 'b', [1, 0])];
		packIdentitySlots(scales, state, [g], 1);
		// A field before it appears: g's block moves, and both headers follow.
		packIdentitySlots(scales, state, [field('f', 3, [null]), g], 1);
		const out = resolvedOf(state);
		for (const id of ['a', 'b']) {
			expect(out[state.offsets.get(id)! + 1]).toBe(state.fieldBases.get('g'));
		}
		expect(state.fieldBases.get('g')).toBe(6);
	});

	it('grows field blocks, not scale headers, when the page gains a group', () => {
		const state = createIdentitySlotState(64);
		const fades: Array<[number[], number[], number, number] | null> = [[[0, 1], [0, 1], 1, 1]];
		const f = field('f', 2, fades);
		packIdentitySlots([on('f', 'a', [0, 1])], state, [f], 1);
		packIdentitySlots([on('f', 'a', [0, 1])], state, [f], 2);
		const out = resolvedOf(state);
		const base = state.offsets.get('a')!;
		expect(identityActivity(out, base, 0, 0)).toBe(0);
		// The new group has no fade: all active.
		expect(identityActivity(out, base, 1, 0)).toBe(1);
	});

	it('agrees with ActivityTable about every id, mid-fade', () => {
		const table = new ActivityTable(null, { charts: () => [] });
		table.resize(3, null);
		table.setActive([1]);
		const state = createIdentitySlotState(64);
		const f: ActivityField = { key: 'f', count: 3, fadeOf: () => table };
		packIdentitySlots([on('f', 'a', [0, 1, 2])], state, [f], 1);
		const out = resolvedOf(state);
		const base = state.offsets.get('a')!;
		for (let id = 0; id < 3; id++) {
			expect(identityActivity(out, base, 0, id)).toBeCloseTo(table.activityOf(id), 5);
		}
	});

	it('forgets the state of a scale that has gone away', () => {
		const state = createIdentitySlotState(64);
		const f = field('f', 1, [null]);
		packIdentitySlots([on('f', 'a', [0]), on('f', 'b', [0])], state, [f], 1);
		packIdentitySlots([on('f', 'a', [0])], state, [f], 1);
		for (const map of [state.counts, state.refs, state.ns, state.resolvedT, state.seenPass]) {
			expect(map.has('b')).toBe(false);
		}
	});

	it('evicts correctly across many passes, with the pass stamp rather than a cleared set', () => {
		// The stamp must mark exactly this pass's scales, every pass: a scale seen
		// in an earlier pass and not this one is gone.
		const state = createIdentitySlotState(64);
		for (let i = 0; i < 50; i++) packIdentitySlots([scale('a', [0]), scale('b', [0])], state);
		packIdentitySlots([scale('b', [0])], state);
		expect([...state.offsets.keys()]).toEqual(['b']);
		for (let i = 0; i < 50; i++) packIdentitySlots([scale('b', [0])], state);
		expect([...state.offsets.keys()]).toEqual(['b']);
	});

	it('wraps the pass counter without forgetting a live scale', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0])], state);
		state.pass = 0x3fffffff;
		packIdentitySlots([scale('a', [0])], state);
		expect(state.pass).toBe(1);
		expect(state.offsets.has('a')).toBe(true);
		packIdentitySlots([scale('a', [0])], state);
		expect(state.offsets.has('a')).toBe(true);
	});
});
