import { describe, it, expect } from 'vitest';
import { SlotTransition } from './SlotTransition';

// The band count and label opacity travel on the slots' clock and must fold,
// settle and snap exactly as the slots do. BandScaleState.test drives slots
// through a scale; these drive SlotTransition directly.

const loop = { addAnimatedSource: () => {}, removeAnimatedSource: () => {} };

/** Three displayed ids, laid out, at rest. */
function laidOut(frames: number[] = []) {
	const s = new SlotTransition(loop, { onFrame: () => frames.push(s.t) });
	s.layout('ids', [0, 1, 2], 3);
	return s;
}

function stepTo(s: SlotTransition, frames: number) {
	for (let i = 0; i < frames; i++) {
		s.clock.step();
		s.clock.updateRenderState(0);
	}
}

function settle(s: SlotTransition) {
	let n = 0;
	while (!s.clock.isAtRest() && n++ < 5000) stepTo(s, 1);
	s.clock._markAtRest();
}

describe('SlotTransition band count', () => {
	it('lands a first layout at its count, with nothing to animate from', () => {
		const s = laidOut();
		expect(s.animatedCount).toBe(3);
		expect(s.isAnimating).toBe(false);
	});

	it('shrinks with the bars when a category leaves, and settles on the new count', () => {
		const s = laidOut();
		s.layout('ids', [0, 2], 3);

		expect(s.animatedCount).toBe(3);
		stepTo(s, 40);
		expect(s.animatedCount).toBeLessThan(3);
		expect(s.animatedCount).toBeGreaterThan(2);
		settle(s);
		expect(s.animatedCount).toBe(2);
	});

	it('continues from where it is when a restart lands mid-transition', () => {
		// A sibling mark's values landing restarts the shared clock. The count,
		// like the slots, must not jump back to where the transition began.
		const s = laidOut();
		s.layout('ids', [0, 2], 3);
		stepTo(s, 40);
		const before = s.animatedCount;

		s.startTransition();
		expect(s.t).toBe(0);
		expect(s.animatedCount).toBeCloseTo(before, 6);
	});

	it('folds a second reorder mid-flight rather than restarting from the first count', () => {
		const s = laidOut();
		s.layout('ids', [0], 3);
		stepTo(s, 40);
		const midway = s.animatedCount;
		expect(midway).toBeLessThan(3);

		s.layout('ids', [0, 1, 2], 3);
		expect(s.animatedCount).toBeCloseTo(midway, 6);
		settle(s);
		expect(s.animatedCount).toBe(3);
	});
});

describe('SlotTransition label opacity', () => {
	it('shows every label of a first layout at once', () => {
		const s = laidOut();
		expect([0, 1, 2].map((id) => s.alphaOf(id))).toEqual([1, 1, 1]);
	});

	it('fades a leaver out and an entrant in, on the same clock', () => {
		const s = laidOut();
		s.layout('ids', [0, 2], 4); // 1 leaves; 3 is a new id, not displayed
		s.layout('ids', [0, 2, 3], 4); // 3 enters

		expect(s.alphaOf(1)).toBe(1);
		expect(s.alphaOf(3)).toBe(0);
		stepTo(s, 40);
		expect(s.alphaOf(1)).toBeGreaterThan(0);
		expect(s.alphaOf(1)).toBeLessThan(1);
		expect(s.alphaOf(3)).toBeGreaterThan(0);
		expect(s.alphaOf(3)).toBeLessThan(1);
		settle(s);
		expect(s.alphaOf(1)).toBe(0);
		expect(s.alphaOf(3)).toBe(1);
	});

	it('fades a label back in from where it had got to when its category returns', () => {
		const s = laidOut();
		s.layout('ids', [0, 2], 3);
		stepTo(s, 40);
		const halfGone = s.alphaOf(1);
		expect(halfGone).toBeLessThan(1);

		s.layout('ids', [0, 1, 2], 3);
		expect(s.alphaOf(1)).toBeCloseTo(halfGone, 6);
		settle(s);
		expect(s.alphaOf(1)).toBe(1);
	});

	it('keeps its opacity across a restart that changes nothing displayed', () => {
		const s = laidOut();
		s.layout('ids', [0, 2], 3);
		stepTo(s, 40);
		const before = s.alphaOf(1);
		s.startTransition();
		expect(s.alphaOf(1)).toBeCloseTo(before, 6);
	});
});

describe('SlotTransition with no loop', () => {
	it('lands a restart at once, whichever call starts it', () => {
		// Nothing can advance t without a loop. A reorder always settled; a
		// value-only restart used to leave t at 0, so every consumer stayed at
		// the start of a transition that could never run.
		const s = new SlotTransition(null);
		s.layout('ids', [0, 1, 2], 3);

		s.layout('ids', [2, 0], 3);
		expect(s.t).toBe(1);
		expect(Array.from(s.snapshot())).toEqual([1, -1, 0]);

		s.startTransition();
		expect(s.t).toBe(1);
		expect(s.isAnimating).toBe(false);
		expect(Array.from(s.snapshot())).toEqual([1, -1, 0]);
	});
});

describe('SlotTransition frame notifications', () => {
	it('reports every driven frame, and once more on settling at exactly t = 1', () => {
		const frames: number[] = [];
		const s = laidOut(frames);
		s.layout('ids', [2, 0, 1], 3);
		stepTo(s, 3);
		expect(frames).toHaveLength(3);

		settle(s);
		expect(frames.at(-1)).toBe(1);
	});
});

describe('SlotTransition per-id reads', () => {
	it('slotOf is the full table’s value for that id, mid-flight, without walking the table', () => {
		const s = laidOut();
		s.layout('ids', [2, 0], 4); // 1 leaves, 3 stays hidden, 2 and 0 swap
		stepTo(s, 25);
		const table = Array.from(s.snapshot());
		for (let id = 0; id < 4; id++) expect(s.slotOf(id)).toBeCloseTo(table[id], 6);
		expect(s.slotOf(99)).toBe(-1);
	});

	it('does not move any id across a fold, whichever call folds', () => {
		// The fold rewrites `from` in place and resets t in the same call. Read
		// on either side of it, every id — staying, swapping, leaving — has to be
		// exactly where it was, or it moves twice.
		const s = laidOut();
		s.layout('ids', [2, 0], 3); // 1 leaves, 2 and 0 swap
		stepTo(s, 25);

		const before = Array.from(s.snapshot());
		s.startTransition();
		expect(s.t).toBe(0);
		expect(Array.from(s.snapshot())).toEqual(before);

		stepTo(s, 10);
		const midway = Array.from(s.snapshot());
		s.layout('ids', [0, 1, 2], 3); // 1 turns back mid-exit
		const after = Array.from(s.snapshot());
		for (let id = 0; id < 3; id++) expect(after[id]).toBeCloseTo(midway[id], 6);
	});
});
