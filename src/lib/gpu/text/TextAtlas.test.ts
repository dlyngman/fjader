import { describe, expect, it, vi } from 'vitest';
import { TextAtlas, type TextStyle } from './TextAtlas.svelte';
import { ATLAS_MAX_ENTRIES } from './atlas-bindings';

const style: TextStyle = { fontSize: 12, fontWeight: 'normal', fontFamily: null };
const bold: TextStyle = { ...style, fontWeight: 'bold' };
const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe('TextAtlas slots', () => {
	it('gives one slot per string and style, counted', async () => {
		const atlas = new TextAtlas();
		const a = atlas.acquire('12.3k', style);
		const b = atlas.acquire('12.3k', style);
		const c = atlas.acquire('12.3k', bold);
		expect(a).toBe(b);
		expect(c).not.toBe(a);
		await tick();
		expect(atlas.items.map((i) => i.text)).toEqual(['12.3k', '12.3k']);

		atlas.release(a);
		await tick();
		expect(atlas.items).toHaveLength(2); // still held once
		atlas.release(b);
		await tick();
		expect(atlas.items.map((i) => i.slot)).toEqual([c]);
	});

	it('reuses a freed slot', () => {
		const atlas = new TextAtlas();
		const a = atlas.acquire('a', style);
		atlas.acquire('b', style);
		atlas.release(a);
		expect(atlas.acquire('c', style)).toBe(a);
	});

	it('republishes items once per microtask, as a new array', async () => {
		const atlas = new TextAtlas();
		const before = atlas.items;
		for (let i = 0; i < 50; i++) atlas.acquire(`s${i}`, style);
		expect(atlas.items).toBe(before);
		await tick();
		expect(atlas.items).not.toBe(before);
		expect(atlas.items).toHaveLength(50);
	});

	it('returns -1 once full, and warns once', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const atlas = new TextAtlas();
		for (let i = 0; i < ATLAS_MAX_ENTRIES; i++) expect(atlas.acquire(`${i}`, style)).toBe(i);
		expect(atlas.acquire('one more', style)).toBe(-1);
		expect(atlas.acquire('and another', style)).toBe(-1);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('ignores releasing -1 and unknown slots', () => {
		const atlas = new TextAtlas();
		expect(() => {
			atlas.release(-1);
			atlas.release(7);
		}).not.toThrow();
	});
});
