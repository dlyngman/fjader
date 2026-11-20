import { describe, expect, it } from 'vitest';
import { TextSlots, withFacetKeys } from './TextSlots';
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

	it('hides at once a row that became another bar, keeps one that is the same bar', () => {
		const atlas = fakeAtlas();
		const slots = new TextSlots(atlas);
		slots.stage(['10', '20', '30'], style, [7, 8, 9]);
		atlas.paint();
		slots.commit();
		// Row 0 is still category 7 (new value); row 1 is now category 5 (a topN
		// change); row 2 is still 9 with the same value.
		const interim = slots.stage(['11', '40', '30'], style, [7, 5, 9]);
		expect(Array.from(interim!)).toEqual([0, -1, 2]);
		atlas.paint();
		expect(Array.from(slots.commit()!)).toEqual([3, 4, 2]);
	});

	it('gives no interim when every row is the same bar', () => {
		const atlas = fakeAtlas();
		const slots = new TextSlots(atlas);
		slots.stage(['a', 'b'], style, [1, 2]);
		atlas.paint();
		slots.commit();
		expect(slots.stage(['c', 'd'], style, [1, 2])).toBeNull();
	});

	it('hides rows past the old count when rows are added', () => {
		const atlas = fakeAtlas();
		const slots = new TextSlots(atlas);
		slots.stage(['a'], style, [1]);
		atlas.paint();
		slots.commit();
		expect(Array.from(slots.stage(['a', 'b'], style, [1, 2])!)).toEqual([0, -1]);
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

describe('withFacetKeys', () => {
	it('is the keys themselves outside a facet grid', () => {
		const keys = new Float32Array([3, 4]);
		expect(withFacetKeys(keys, null)).toBe(keys);
		expect(withFacetKeys(null, new Float32Array([0, 1]))).toBeNull();
	});

	it('tells the same category in two cells apart, and keeps one cell’s rows equal', () => {
		// Row 1 is Dream in cell 0, then Dream in cell 1: no longer the same row.
		const before = withFacetKeys(new Float32Array([2, 5]), new Float32Array([0, 0]))!;
		const after = withFacetKeys(new Float32Array([2, 5]), new Float32Array([0, 1]))!;
		expect(after[0]).toBe(before[0]);
		expect(after[1]).not.toBe(before[1]);
		// Exact: a category id differs by 1, so do the keys.
		const k = withFacetKeys(new Float32Array([7, 8]), new Float32Array([3, 3]))!;
		expect(k[1] - k[0]).toBe(1);
	});
});
