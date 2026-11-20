import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TextAtlas, type TextStyle } from './TextAtlas.svelte';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
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

describe('TextAtlas surfaces (one per canvas: a facet grid paints one per cell)', () => {
	const style: TextStyle = { fontSize: 10, fontWeight: 'normal', fontFamily: null };

	// Node has no WebGPU: the usage flags paint reads, as plain numbers.
	beforeAll(() => {
		vi.stubGlobal('GPUBufferUsage', { UNIFORM: 0x40, COPY_DST: 0x8 });
		vi.stubGlobal('GPUTextureUsage', {
			TEXTURE_BINDING: 0x4,
			COPY_DST: 0x2,
			RENDER_ATTACHMENT: 0x10
		});
	});
	afterAll(() => vi.unstubAllGlobals());

	/** Just what attach and paint touch: buffers, textures, uploads, rebinding. */
	function fakeGpu() {
		const writes: Array<{ buffer: unknown; offset: number }> = [];
		const bound: Record<string, unknown> = {};
		const device = {
			limits: { maxTextureDimension2D: 8192 },
			createBuffer: (d: { label: string }) => ({ label: d.label, destroy() {} }),
			createTexture: (d: { size: [number, number] }) => ({
				width: d.size[0],
				height: d.size[1],
				createView: () => ({}),
				destroy() {}
			}),
			queue: {
				writeBuffer: (buffer: unknown, offset: number) => writes.push({ buffer, offset }),
				drawElementImageToTexture: () => {}
			}
		} as unknown as GPUDevice;
		const coordinator = {
			setChartTextAtlas: (id: string, binding: unknown) => (bound[id] = binding),
			invalidateChart: () => {}
		} as unknown as GPUCoordinator;
		return { device, coordinator, writes, bound };
	}

	/** A canvas and an atlas container holding spans for `slots` (their strings as acquired). */
	function paintWith(atlas: TextAtlas, chartId: string, spans: Array<[number, string]>): void {
		const canvas = {
			getElementImageDefaultSize: () => ({ width: 200, height: 40 })
		} as unknown as HTMLCanvasElement;
		const box = { left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40 };
		const container = {
			children: spans.map(([slot, text], i) => ({
				dataset: { slot: String(slot) },
				textContent: text,
				getBoundingClientRect: () => ({ left: i * 40, top: 0, right: i * 40 + 30, bottom: 12 })
			})),
			getBoundingClientRect: () => box
		} as unknown as HTMLElement;
		atlas.paint(canvas, container, chartId);
	}

	it('a string is drawable once every canvas that paints has it; one not painted yet holds nothing back', () => {
		const { device, coordinator } = fakeGpu();
		const atlas = new TextAtlas();
		const slot = atlas.acquire('42', style);
		atlas.attach(device, coordinator, 'cell-a');
		atlas.attach(device, coordinator, 'cell-b');
		expect(atlas.isRasterized(slot)).toBe(false);

		paintWith(atlas, 'cell-a', [[slot, '42']]);
		// cell-b has not painted: it does not hold the label back.
		expect(atlas.isRasterized(slot)).toBe(true);

		paintWith(atlas, 'cell-b', []);
		// cell-b painted without it: not drawable everywhere yet.
		expect(atlas.isRasterized(slot)).toBe(false);

		paintWith(atlas, 'cell-b', [[slot, '42']]);
		expect(atlas.isRasterized(slot)).toBe(true);
	});

	it('each canvas binds its own texture and table, by its own chart id', () => {
		const { device, coordinator, bound } = fakeGpu();
		const atlas = new TextAtlas();
		const slot = atlas.acquire('a', style);
		atlas.attach(device, coordinator, 'cell-a');
		atlas.attach(device, coordinator, 'cell-b');
		paintWith(atlas, 'cell-a', [[slot, 'a']]);
		paintWith(atlas, 'cell-b', [[slot, 'a']]);
		expect(Object.keys(bound).sort()).toEqual(['cell-a', 'cell-b']);
		expect(bound['cell-a']).not.toBe(bound['cell-b']);
	});

	it('a release clears the slot in every canvas; a detached canvas no longer counts', () => {
		const { device, coordinator, writes, bound } = fakeGpu();
		const atlas = new TextAtlas();
		const slot = atlas.acquire('x', style);
		atlas.attach(device, coordinator, 'cell-a');
		atlas.attach(device, coordinator, 'cell-b');
		paintWith(atlas, 'cell-a', [[slot, 'x']]);
		paintWith(atlas, 'cell-b', []);
		expect(atlas.isRasterized(slot)).toBe(false);

		atlas.detach('cell-b');
		expect(bound['cell-b']).toBeNull();
		expect(atlas.isRasterized(slot)).toBe(true);

		const before = writes.length;
		atlas.release(slot);
		expect(atlas.isRasterized(slot)).toBe(false);
		// One zeroed row, for the one canvas still attached.
		expect(writes.length - before).toBe(1);
	});
});
