import { describe, it, expect, vi } from 'vitest';
import {
	IDENTITY_SLOT_EMPTY,
	createIdentitySlotState,
	packIdentitySlots,
	type IdentitySlotScale,
	type IdentitySlotState
} from './identity-slot-packing';
import { resolveSlotsReference } from './SlotResolveShader';
import { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';

/** A scale whose slot table is the given permutation. */
function scale(id: string, slots: number[], version = 1): IdentitySlotScale {
	return { id, slotCount: slots.length, slotTable: Float32Array.from(slots), slotVersion: version };
}

/** Read one scale's block back the way the shader's identitySlot() does. */
function readBlock(buffer: Float32Array, base: number) {
	const count = buffer[base];
	return { count, slots: Array.from(buffer.slice(base + 2, base + 2 + count)) };
}

/** The t the shader would interpolate with, from the same block header. */
function readT(buffer: Float32Array, base: number) {
	return buffer[base + 1];
}

describe('packIdentitySlots layout', () => {
	it('reserves index 0 as a permanent empty block', () => {
		const state = createIdentitySlotState(64);
		// Before anything is packed, and after: a scale parked here must find
		// count 0 and discard, which is the whole point of the fallback.
		expect(state.buffer[IDENTITY_SLOT_EMPTY]).toBe(0);
		packIdentitySlots([scale('a', [0, 1, 2])], state);
		expect(state.buffer[IDENTITY_SLOT_EMPTY]).toBe(0);
	});

	it('writes a count header before each block', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [2, 0, 1])], state);

		const base = state.offsets.get('a')!;
		expect(base).toBe(1); // straight after the empty block
		expect(readBlock(state.buffer, base)).toEqual({ count: 3, slots: [2, 0, 1] });
	});

	it('lays consecutive scales end to end with no overlap', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1]), scale('b', [1, 0, 2]), scale('c', [0])], state);

		const [a, b, c] = ['a', 'b', 'c'].map((id) => state.offsets.get(id)!);
		expect([a, b, c]).toEqual([1, 5, 10]); // 1 + (2+2) = 5, 5 + (3+2) = 10
		expect(readBlock(state.buffer, a)).toEqual({ count: 2, slots: [0, 1] });
		expect(readBlock(state.buffer, b)).toEqual({ count: 3, slots: [1, 0, 2] });
		expect(readBlock(state.buffer, c)).toEqual({ count: 1, slots: [0] });
	});

	it('reports the used prefix so the caller uploads only that much', () => {
		const state = createIdentitySlotState(16384);
		const { length } = packIdentitySlots([scale('a', [0, 1]), scale('b', [0])], state);
		// 1 empty + (2+2) + (1+2)
		expect(length).toBe(8);
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
		expect(readT(state.buffer, base)).toBe(1);
	});

	it('writes from and to into their own buffers at the same base', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots(
			[
				{
					id: 'a',
					slotCount: Float32Array.from([0, 1, 2]).length,

					slotTable: Float32Array.from([0, 1, 2]),
					slotFrom: Float32Array.from([2, 1, 0]),
					slotTo: Float32Array.from([0, 1, 2]),
					t: 0.25,
					slotVersion: 1
				}
			],
			state
		);

		const base = state.offsets.get('a')!;
		// One base serves both buffers — that is what lets p4 stay a single float.
		expect(readBlock(state.buffer, base)).toEqual({ count: 3, slots: [2, 1, 0] });
		expect(readBlock(state.bufferTo, base)).toEqual({ count: 3, slots: [0, 1, 2] });
		expect(readT(state.buffer, base)).toBeCloseTo(0.25, 6);
		expect(readT(state.bufferTo, base)).toBeCloseTo(0.25, 6);
	});

	it('keeps the empty block empty in both buffers', () => {
		// A parked scale reads count 0 from whichever buffer the shader asks, so
		// both need the header — not just the one carrying `from`.
		const state = createIdentitySlotState(64);
		expect(state.buffer[IDENTITY_SLOT_EMPTY]).toBe(0);
		expect(state.bufferTo[IDENTITY_SLOT_EMPTY]).toBe(0);
	});

	it('counts the t header against capacity, not just the slots', () => {
		// Two floats of header per block, so a budget that fit before may not.
		const state = createIdentitySlotState(8);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// 1 empty + (4 slots + 2 header) = 7; a second 4-id scale needs 6 more.
		packIdentitySlots([scale('a', [0, 1, 2, 3]), scale('b', [0])], state);
		expect(state.offsets.get('a')).toBe(1);
		expect(state.offsets.get('b')).toBe(IDENTITY_SLOT_EMPTY);
		warn.mockRestore();
	});
});

describe('packIdentitySlots dirty tracking', () => {
	it('is dirty on first pack and clean when nothing moved', () => {
		const state = createIdentitySlotState(64);
		const scales = [scale('a', [0, 1]), scale('b', [0])];

		expect(packIdentitySlots(scales, state).dirty).toBe(true);
		// A static chart must cost no writeBuffer, which is the only reason this
		// function returns a flag rather than always uploading.
		expect(packIdentitySlots(scales, state).dirty).toBe(false);
	});

	it('is clean on a repeat pack of a scale that declares no slotVersion', () => {
		// The collector admits any scale with a slot table, so a new scale kind can
		// opt in without declaring a version. It must not then cost a re-upload —
		// and, if it did not fit, a capacity warning — on every frame.
		const state = createIdentitySlotState(64);
		const versionless = { id: 'a', slotCount: 2, slotTable: Float32Array.from([0, 1]) };

		expect(packIdentitySlots([versionless], state).dirty).toBe(true);
		expect(packIdentitySlots([versionless], state).dirty).toBe(false);
		expect(packIdentitySlots([versionless], state).dirty).toBe(false);
	});

	it('is dirty when a slot table is rebuilt', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots([scale('a', [0, 1, 2], 1)], state);

		// A reorder: same length, same base, new contents and a bumped version.
		const { dirty } = packIdentitySlots([scale('a', [2, 1, 0], 2)], state);
		expect(dirty).toBe(true);
		expect(readBlock(state.buffer, state.offsets.get('a')!).slots).toEqual([2, 1, 0]);
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
		// 1 empty + (4+2) = 7 used; the next needs 6 and only 3 remain.
		packIdentitySlots([scale('a', [0, 1, 2, 3]), scale('b', [0, 1, 2, 3])], state);

		expect(state.offsets.get('a')).toBe(1);
		expect(state.offsets.get('b')).toBe(IDENTITY_SLOT_EMPTY);
		// Parked, not merely unwritten: a lookup there finds count 0 and
		// discards, rather than reading scale "a"'s slots.
		expect(state.buffer[IDENTITY_SLOT_EMPTY]).toBe(0);
		warn.mockRestore();
	});

	it('still places a later scale small enough to fit', () => {
		// The reason the loop does not break on the first scale that overflows.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const state = createIdentitySlotState(12);
		packIdentitySlots(
			[scale('a', [0, 1, 2, 3]), scale('huge', new Array(20).fill(0)), scale('c', [0])],
			state
		);

		expect(state.offsets.get('a')).toBe(1);
		expect(state.offsets.get('huge')).toBe(IDENTITY_SLOT_EMPTY);
		expect(state.offsets.get('c')).toBe(7);
		expect(readBlock(state.buffer, 7)).toEqual({ count: 1, slots: [0] });
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
		expect(state.offsets.get('b')).toBe(1);
		expect(readBlock(state.buffer, 1)).toEqual({ count: 4, slots: [0, 1, 2, 3] });
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

		const { dirty, length } = packIdentitySlots([], state);

		expect(state.offsets.size).toBe(0);
		expect(state.versions.size).toBe(0);
		expect(dirty).toBe(false); // nothing to write; p4 falls back to the empty block
		expect(length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// The shader's view, evaluated in JS against the packed buffers.
// ---------------------------------------------------------------------------

describe('what the shader reads back', () => {
	/** identitySlot(base, id) from ScaleTemplateSystem, in TypeScript. */
	function identitySlot(state: IdentitySlotState, base: number, id: number): number {
		const count = state.buffer[base];
		if (id >= count) return -1;
		const t = state.buffer[base + 1];
		const a = state.buffer[base + 2 + id];
		const b = state.bufferTo[base + 2 + id];
		return a + (b - a) * t;
	}

	it('agrees with the scale about every id, mid-transition', () => {
		// The two halves of the design meet here: JS computes slotTable as
		// mix(from, to, t) and the vertex stage computes the same thing from the
		// same three numbers. If they drift, bars are in the wrong slots.
		const s = new BandScaleState('species', [], {
			gpuCoordinator: { addAnimatedSource: () => {} }
		});
		s.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		s.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		s.updateDomainFromExtents();

		// Chinstrap(1) leaves: a real slot in both tables, -1 in slotTarget.
		s.addMark(['Adelie', 'Gentoo'], 'mark-1');
		s.updateDomainFromExtents();
		for (let i = 0; i < 15; i++) {
			s.clock.step();
			s.clock.updateRenderState(0);
		}

		const state = createIdentitySlotState(64);
		packIdentitySlots(
			[{ id: s.id, slotCount: s.slotCount, slotFrom: s.slotFrom, slotTo: s.slotTo, t: s.t }],
			state
		);
		const base = state.offsets.get(s.id)!;

		for (let id = 0; id < 3; id++) {
			expect(identitySlot(state, base, id)).toBeCloseTo(s.slotTable[id], 5);
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
		packIdentitySlots(
			[
				{
					id: 'a',
					slotCount: Float32Array.from([0, -1, 1]).length,

					slotTable: Float32Array.from([0, -1, 1]),
					slotFrom: Float32Array.from([0, -1, 1]),
					slotTo: Float32Array.from([1, -1, 0]),
					t: 0.5
				}
			],
			state
		);
		const base = state.offsets.get('a')!;
		expect(identitySlot(state, base, 1)).toBe(-1);
	});
});

// ---------------------------------------------------------------------------
// bases — the per-element block lookup the resolve kernel needs
// ---------------------------------------------------------------------------
//
// The kernel reads `t` from its element's block header, and blocks are
// variable-length, so a flat thread cannot find its own header by arithmetic.
// `bases[i]` is that lookup, and getting it wrong means an element reads
// ANOTHER scale's `t` — which renders, plausibly, at the wrong point in a
// transition. That is the failure class this whole module exists to prevent
// (the count header does the same job for ids), so it is asserted rather than
// assumed.

describe('packIdentitySlots: bases', () => {
	it('points every float of a block at that block, header included', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots(
			[
				{
					id: 'a',
					slotCount: Float32Array.from([0, 1, 2]).length,
					slotTable: Float32Array.from([0, 1, 2]),
					slotVersion: 1
				},
				{
					id: 'b',
					slotCount: Float32Array.from([1, 0]).length,
					slotTable: Float32Array.from([1, 0]),
					slotVersion: 1
				}
			],
			state
		);

		const a = state.offsets.get('a')!;
		const b = state.offsets.get('b')!;

		// count + t + 3 slots, then count + t + 2 slots.
		for (let i = a; i < a + 5; i++) expect(state.bases[i]).toBe(a);
		for (let i = b; i < b + 4; i++) expect(state.bases[i]).toBe(b);
	});

	it('lets a thread recover its own t, which is the point of it', () => {
		const state = createIdentitySlotState(64);
		packIdentitySlots(
			[
				{
					id: 'a',
					slotCount: Float32Array.from([0, 1]).length,

					slotTable: Float32Array.from([0, 1]),
					slotFrom: Float32Array.from([0, 1]),
					slotTo: Float32Array.from([1, 0]),
					t: 0.25,
					slotVersion: 1
				},
				{
					id: 'b',
					slotCount: Float32Array.from([0]).length,

					slotTable: Float32Array.from([0]),
					slotFrom: Float32Array.from([0]),
					slotTo: Float32Array.from([3]),
					t: 0.75,
					slotVersion: 1
				}
			],
			state
		);

		// Exactly what the kernel does: for each element, find its block, read t
		// from the header, mix. Two scales with DIFFERENT t, because a shared t
		// would pass this test by accident.
		const tAt = (i: number) => state.buffer[state.bases[i] + 1];
		const a = state.offsets.get('a')!;
		const b = state.offsets.get('b')!;

		expect(tAt(a + 2)).toBeCloseTo(0.25, 5);
		expect(tAt(a + 3)).toBeCloseTo(0.25, 5);
		expect(tAt(b + 2)).toBeCloseTo(0.75, 5);

		const resolve = (i: number) => state.buffer[i] + (state.bufferTo[i] - state.buffer[i]) * tAt(i);
		expect(resolve(a + 2)).toBeCloseTo(0.25, 5); // 0 -> 1 at t=0.25
		expect(resolve(a + 3)).toBeCloseTo(0.75, 5); // 1 -> 0 at t=0.25
		expect(resolve(b + 2)).toBeCloseTo(2.25, 5); // 0 -> 3 at t=0.75
	});

	it('rewrites bases when a scale shrinks and shifts the one after it', () => {
		// The case a stale bases entry would survive: 'b' moves because 'a' got
		// smaller, so every float of b's block must be re-pointed. Without the
		// rewrite, b's slots would read a's t.
		const state = createIdentitySlotState(64);
		packIdentitySlots(
			[
				{
					id: 'a',
					slotCount: Float32Array.from([0, 1, 2, 3]).length,
					slotTable: Float32Array.from([0, 1, 2, 3]),
					t: 0.1,
					slotVersion: 1
				},
				{
					id: 'b',
					slotCount: Float32Array.from([0]).length,
					slotTable: Float32Array.from([0]),
					t: 0.9,
					slotVersion: 1
				}
			],
			state
		);

		packIdentitySlots(
			[
				{
					id: 'a',
					slotCount: Float32Array.from([0, 1]).length,
					slotTable: Float32Array.from([0, 1]),
					t: 0.1,
					slotVersion: 2
				},
				{
					id: 'b',
					slotCount: Float32Array.from([0]).length,
					slotTable: Float32Array.from([0]),
					t: 0.9,
					slotVersion: 1
				}
			],
			state
		);

		const b = state.offsets.get('b')!;
		for (let i = b; i < b + 3; i++) expect(state.bases[i]).toBe(b);
		// toBeCloseTo, not toBe: these are Float32Array round trips.
		expect(state.buffer[state.bases[b + 2] + 1]).toBeCloseTo(0.9, 5);
	});
});

// ---------------------------------------------------------------------------
// The resolve kernel's formula, against the packed buffers
// ---------------------------------------------------------------------------
//
// The mix moved out of the vertex stage and into a compute pass, so it is now
// reachable only through a device — which is the condition that got this module
// extracted in the first place.
// `resolveSlotsReference` is the JS twin the WGSL is written against; these
// tests pin it to the behaviour the vertex stage had, so the port has something
// to be wrong against rather than only a running browser.

describe('resolveSlotsReference', () => {
	/** What the vertex stage used to compute, kept here as the oracle. */
	function vertexStageMix(state: IdentitySlotState, base: number, id: number): number {
		const count = state.buffer[base];
		if (id >= count) return -1;
		const t = state.buffer[base + 1];
		const a = state.buffer[base + 2 + id];
		const b = state.bufferTo[base + 2 + id];
		return a + (b - a) * t;
	}

	it('reproduces the vertex-stage mix for every id of every scale', () => {
		const state = createIdentitySlotState(64);
		const scales = [
			{
				id: 'a',
				slotCount: Float32Array.from([0, 1, 2]).length,

				slotTable: Float32Array.from([0, 1, 2]),
				slotFrom: Float32Array.from([0, 1, 2]),
				slotTo: Float32Array.from([2, 0, 1]),
				t: 0.4,
				slotVersion: 1
			},
			{
				id: 'b',
				slotCount: Float32Array.from([1, -1, 0]).length,

				slotTable: Float32Array.from([1, -1, 0]),
				slotFrom: Float32Array.from([1, -1, 0]),
				slotTo: Float32Array.from([0, -1, 1]),
				t: 0.85,
				slotVersion: 1
			}
		];
		const { length } = packIdentitySlots(scales, state);

		const out = new Float32Array(state.buffer.length);
		resolveSlotsReference(state.buffer, state.bufferTo, state.bases, length, out);

		for (const s of scales) {
			const base = state.offsets.get(s.id)!;
			// The header survives: count is identical in both halves, so mixing it
			// returns it. The shader still reads its bound from `resolved`.
			expect(out[base]).toBe(s.slotTable.length);
			for (let id = 0; id < s.slotTable.length; id++) {
				expect(out[base + 2 + id]).toBeCloseTo(vertexStageMix(state, base, id), 5);
			}
		}
	});

	it('leaves an undisplayed id at -1 without a branch', () => {
		// -1 in both halves for any t. This is why neither the kernel nor the
		// shader has a sentinel case.
		const state = createIdentitySlotState(64);
		const { length } = packIdentitySlots(
			[
				{
					id: 'a',
					slotCount: Float32Array.from([0, -1, 1]).length,

					slotTable: Float32Array.from([0, -1, 1]),
					slotFrom: Float32Array.from([0, -1, 1]),
					slotTo: Float32Array.from([1, -1, 0]),
					t: 0.5,
					slotVersion: 1
				}
			],
			state
		);
		const out = new Float32Array(state.buffer.length);
		resolveSlotsReference(state.buffer, state.bufferTo, state.bases, length, out);
		const base = state.offsets.get('a')!;
		expect(out[base + 2 + 1]).toBe(-1);
	});

	it('gives each scale its OWN t, which is the whole reason bases exists', () => {
		// A shared t would pass every other test in this file. Two scales at
		// different points in their transitions is the case that separates
		// "reads t from its own block" from "reads whichever t it happened to
		// find" — and reading a neighbour's t renders plausibly, at the wrong
		// point in a transition, which is the worst kind of wrong here.
		const state = createIdentitySlotState(64);
		const { length } = packIdentitySlots(
			[
				{
					id: 'a',
					slotCount: Float32Array.from([0]).length,

					slotTable: Float32Array.from([0]),
					slotFrom: Float32Array.from([0]),
					slotTo: Float32Array.from([10]),
					t: 0,
					slotVersion: 1
				},
				{
					id: 'b',
					slotCount: Float32Array.from([0]).length,

					slotTable: Float32Array.from([0]),
					slotFrom: Float32Array.from([0]),
					slotTo: Float32Array.from([10]),
					t: 1,
					slotVersion: 1
				}
			],
			state
		);
		const out = new Float32Array(state.buffer.length);
		resolveSlotsReference(state.buffer, state.bufferTo, state.bases, length, out);

		expect(out[state.offsets.get('a')! + 2]).toBeCloseTo(0, 5);
		expect(out[state.offsets.get('b')! + 2]).toBeCloseTo(10, 5);
	});

	it('does not write past the packed prefix', () => {
		// The dispatch covers `length` threads; the tail must stay as it was, or
		// a buffer dump is full of values nothing put there.
		const state = createIdentitySlotState(64);
		const { length } = packIdentitySlots(
			[
				{
					id: 'a',
					slotCount: Float32Array.from([0, 1]).length,
					slotTable: Float32Array.from([0, 1]),
					t: 1,
					slotVersion: 1
				}
			],
			state
		);
		const out = new Float32Array(state.buffer.length).fill(999);
		resolveSlotsReference(state.buffer, state.bufferTo, state.bases, length, out);
		expect(out[length]).toBe(999);
		expect(out[state.buffer.length - 1]).toBe(999);
	});
});
