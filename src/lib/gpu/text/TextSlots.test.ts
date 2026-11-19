import { describe, expect, it } from 'vitest';
import { TextSlots } from './TextSlots';
import type { TextAtlas, TextStyle } from './TextAtlas.svelte';

const style: TextStyle = { fontSize: 11, fontWeight: 'normal', fontFamily: null };

/** An atlas stand-in: slots per string, refcounts, and which are painted. */
function fakeAtlas() {
	const slots = new Map<string, number>();
	const refs = new Map<number, number>();
	const painted = new Set<number>();
	let next = 0;
	const atlas = {
		acquire(text: string) {
			let slot = slots.get(text);
			if (slot === undefined) {
				slot = next++;
				slots.set(text, slot);
			}
			refs.set(slot, (refs.get(slot) ?? 0) + 1);
			return slot;
		},
		release(slot: number) {
			const n = (refs.get(slot) ?? 0) - 1;
			if (n <= 0) {
				refs.delete(slot);
				painted.delete(slot);
				for (const [k, v] of slots) if (v === slot) slots.delete(k);
			} else refs.set(slot, n);
		},
		isRasterized: (slot: number) => painted.has(slot),
		paint: () => {
			for (const slot of refs.keys()) painted.add(slot);
		},
		live: () => [...refs.keys()].sort()
	};
	return atlas as typeof atlas & TextAtlas;
}

describe('TextSlots', () => {
	it('commits only once every new string is painted', () => {
		const atlas = fakeAtlas();
		const slots = new TextSlots(atlas);
		slots.stage(['10', '20'], style);
		expect(slots.commit()).toBeNull();
		atlas.paint();
		expect(Array.from(slots.commit()!)).toEqual([0, 1]);
		expect(slots.commit()).toBeNull(); // nothing staged any more
	});

	it('keeps the old strings until the new ones are painted, then releases them', () => {
		const atlas = fakeAtlas();
		const slots = new TextSlots(atlas);
		slots.stage(['10', '20'], style);
		atlas.paint();
		slots.commit();
		slots.stage(['11', '20'], style);
		// The old '10' is still held: rows still point at it.
		expect(atlas.live()).toEqual([0, 1, 2]);
		expect(slots.commit()).toBeNull();
		expect(Array.from(slots.current!)).toEqual([0, 1]);
		atlas.paint();
		expect(Array.from(slots.commit()!)).toEqual([2, 1]);
		expect(atlas.live()).toEqual([1, 2]);
	});

	it('drops an unpainted stage when a newer one arrives', () => {
		const atlas = fakeAtlas();
		const slots = new TextSlots(atlas);
		slots.stage(['a'], style);
		slots.stage(['b'], style);
		expect(atlas.live()).toEqual([1]);
		atlas.paint();
		expect(Array.from(slots.commit()!)).toEqual([1]);
	});

	it('commits at once when every string is already painted', () => {
		const atlas = fakeAtlas();
		const slots = new TextSlots(atlas);
		slots.stage(['x', null], style);
		atlas.paint();
		slots.commit();
		slots.stage([null, 'x'], style);
		expect(Array.from(slots.commit()!)).toEqual([-1, 0]);
	});

	it('releases everything on destroy', () => {
		const atlas = fakeAtlas();
		const slots = new TextSlots(atlas);
		slots.stage(['a'], style);
		atlas.paint();
		slots.commit();
		slots.stage(['b'], style);
		slots.destroy();
		expect(atlas.live()).toEqual([]);
	});
});
