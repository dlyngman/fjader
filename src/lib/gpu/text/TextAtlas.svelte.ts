/**
 * A chart's text atlas: every distinct string its text layers draw, rasterized
 * by the browser into one texture with HTML-in-Canvas.
 *
 * HOW. The chart's canvas hosts a `drawable` container (WebGPUCanvas renders
 * it from `items`) with one span per entry, styled by CSS. The container is
 * laid out like any element: a fixed width, wrapping, so its rows act as shelf
 * packing. When it changes, the canvas fires `paint`, and `paint()` here draws
 * the container into the atlas texture in one call
 * (`GPUQueue.drawElementImageToTexture`) and reads each span's rectangle from
 * layout into the entry table. That is change-time work: nothing here runs
 * per frame.
 *
 * WHY WHOLE STRINGS. The browser shapes, kerns, ligates, handles bidi and
 * falls back between fonts. A label is one quad over its string's rectangle;
 * nothing in fjader lays out text.
 *
 * SLOTS. An entry's slot is its index in the entry table, and what a text
 * layer stores per row. It is stable for the entry's life: a repaint moves
 * rectangles, never slots, so a layout change rewrites the table and no mark's
 * data. Entries are refcounted by (string, style); a slot is freed at zero and
 * its row zeroed at once, so a reuse never shows the old string.
 *
 * COLOUR. Strings rasterize white; shaders tint them. One entry serves every
 * colour and every dimming level.
 *
 * The texture is sized when it is drawn, from the container's laid-out size:
 * a change can wrap the container onto another row, and a texture sized
 * before would cut that row off.
 */

import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import {
	ATLAS_ENTRY_BYTES,
	ATLAS_FORMAT,
	ATLAS_MAX_ENTRIES,
	ATLAS_TABLE_BYTES
} from './atlas-bindings';

/** How a string is drawn. Part of an entry's identity: the same text in two styles is two entries. */
export interface TextStyle {
	/** CSS pixels. */
	fontSize: number;
	fontWeight: string;
	/** A CSS font-family list, or null for the chart's (`--fjader-font`). */
	fontFamily: string | null;
}

/** One span in the atlas container. */
export interface AtlasItem {
	slot: number;
	text: string;
	/** Inline CSS for the span. */
	css: string;
}

/** The container's width in CSS pixels: 2048 texels at a device pixel ratio of 2. */
export const ATLAS_CSS_WIDTH = 1024;

/** Texture height grows in steps of this many texels, so growth is rare. */
const HEIGHT_STEP = 256;

const DEFAULT_FAMILY = 'var(--fjader-font, system-ui, sans-serif)';

/** The HTML-in-Canvas entry points this needs, which lib.dom does not type yet. */
interface DrawableCanvas extends HTMLCanvasElement {
	getElementImageDefaultSize(element: Element): { width: number; height: number };
}
interface DrawableQueue extends GPUQueue {
	drawElementImageToTexture(
		source: { source: Element },
		destination: { texture: GPUTexture; size: [number, number] }
	): void;
}

/**
 * What to say when HTML-in-Canvas is missing: every chart's text (axes,
 * labels, TextMark) is rasterized through it, so without it charts would
 * draw with no text at all.
 */
export const HTML_IN_CANVAS_MISSING_MESSAGE =
	`This browser cannot draw HTML into WebGPU textures (HTML-in-Canvas, ` +
	`GPUQueue.drawElementImageToTexture), which fjader requires: every chart's ` +
	`text, its axes' labels included, is rasterized through it. Chrome 157 or ` +
	`later supports it. Without it charts would draw no text, so this fails ` +
	`here instead.`;

/** Whether this browser can draw elements into WebGPU textures (Chrome 157+). */
export function htmlInCanvasSupported(): boolean {
	return (
		typeof GPUQueue !== 'undefined' &&
		'drawElementImageToTexture' in GPUQueue.prototype &&
		typeof HTMLCanvasElement !== 'undefined' &&
		'getElementImageDefaultSize' in HTMLCanvasElement.prototype
	);
}

function styleKey(text: string, style: TextStyle): string {
	return `${style.fontWeight}|${style.fontSize}|${style.fontFamily ?? ''}|${text}`;
}

function styleCss(style: TextStyle): string {
	return `font: ${style.fontWeight} ${style.fontSize}px ${style.fontFamily ?? DEFAULT_FAMILY}`;
}

interface Entry {
	key: string;
	item: AtlasItem;
	refs: number;
}

export class TextAtlas {
	/** The spans WebGPUCanvas renders, keyed by slot. Replaced, never mutated, when entries change. */
	items = $state<AtlasItem[]>([]);

	/**
	 * Bumped after each upload: a string acquired before it may be drawable
	 * now (`isRasterized`). What a text layer waits on before switching to new
	 * strings, so a label never shows an entry not painted yet.
	 */
	paintVersion = $state(0);

	/** Whether each slot's string is in the texture. */
	readonly #rasterized = new Uint8Array(ATLAS_MAX_ENTRIES);

	readonly #entries: (Entry | null)[] = [];
	readonly #byKey = new Map<string, number>();
	readonly #free: number[] = [];
	#itemsScheduled = false;
	#warnedFull = false;

	/** The entry table, mirrored on the CPU: rewritten at each paint. */
	readonly #table = new Float32Array(ATLAS_TABLE_BYTES / 4);
	readonly #zeroRow = new Float32Array(ATLAS_ENTRY_BYTES / 4);

	#device: GPUDevice | null = null;
	#coordinator: GPUCoordinator | null = null;
	#chartId = '';
	#texture: GPUTexture | null = null;
	#entriesBuffer: GPUBuffer | null = null;

	/**
	 * A slot for `text` in `style`, counted: release it once per acquire. -1
	 * when the table is full (4096 entries): that row draws nothing.
	 */
	acquire(text: string, style: TextStyle): number {
		const key = styleKey(text, style);
		const existing = this.#byKey.get(key);
		if (existing !== undefined) {
			this.#entries[existing]!.refs++;
			return existing;
		}
		const slot = this.#free.length ? this.#free.pop()! : this.#entries.length;
		if (slot >= ATLAS_MAX_ENTRIES) {
			if (!this.#warnedFull) {
				this.#warnedFull = true;
				console.warn(
					`[fjader] A chart's text atlas is full (${ATLAS_MAX_ENTRIES} distinct strings); further labels are not drawn.`
				);
			}
			return -1;
		}
		this.#entries[slot] = { key, refs: 1, item: { slot, text, css: styleCss(style) } };
		this.#rasterized[slot] = 0;
		this.#byKey.set(key, slot);
		this.#scheduleItems();
		return slot;
	}

	release(slot: number): void {
		if (slot < 0) return;
		const entry = this.#entries[slot];
		if (!entry || --entry.refs > 0) return;
		this.#entries[slot] = null;
		this.#byKey.delete(entry.key);
		this.#free.push(slot);
		this.#rasterized[slot] = 0;
		this.#table.fill(0, slot * 4, slot * 4 + 4);
		if (this.#entriesBuffer && this.#device) {
			this.#device.queue.writeBuffer(this.#entriesBuffer, slot * ATLAS_ENTRY_BYTES, this.#zeroRow);
		}
		this.#scheduleItems();
	}

	/** Republish `items` once per microtask, however many entries changed. */
	#scheduleItems(): void {
		if (this.#itemsScheduled) return;
		this.#itemsScheduled = true;
		queueMicrotask(() => {
			this.#itemsScheduled = false;
			const items: AtlasItem[] = [];
			for (const entry of this.#entries) if (entry) items.push(entry.item);
			this.items = items;
		});
	}

	/** Start drawing: the chart's device and its id at the coordinator. */
	attach(device: GPUDevice, coordinator: GPUCoordinator, chartId: string): void {
		this.#device = device;
		this.#coordinator = coordinator;
		this.#chartId = chartId;
	}

	/**
	 * Draw `container` into the texture and rebuild the entry table. Runs in the
	 * canvas's `paint` handler, which fires after layout whenever the container
	 * would be drawn differently.
	 */
	paint(canvas: HTMLCanvasElement, container: HTMLElement): void {
		const device = this.#device;
		if (!device || !this.#coordinator) return;
		const size = (canvas as DrawableCanvas).getElementImageDefaultSize(container);
		const width = Math.ceil(size.width);
		const height = Math.ceil(size.height);
		if (width === 0 || height === 0) return;

		this.#ensureResources(device, width, height);
		const texture = this.#texture!;
		(device.queue as DrawableQueue).drawElementImageToTexture(
			{ source: container },
			{ texture, size: [Math.min(texture.width, width), Math.min(texture.height, height)] }
		);

		// Layout to texels: the canvas rasterizes at its own scale (its backing
		// store over its CSS size, the device pixel ratio).
		const box = container.getBoundingClientRect();
		const scale = box.width > 0 ? size.width / box.width : 1;
		const table = this.#table;
		let maxSlot = -1;
		for (const child of container.children) {
			const slot = Number((child as HTMLElement).dataset.slot);
			const entry = slot >= 0 ? this.#entries[slot] : null;
			// A span still showing a slot's previous string (a reuse the DOM has
			// not caught up with) is not this entry's: it is painted next time.
			if (!entry || child.textContent !== entry.item.text) continue;
			const r = child.getBoundingClientRect();
			// Outward to whole texels: quads snap to device pixels, so a whole-texel
			// rectangle maps texels to pixels one to one. The container's gap keeps
			// neighbours out of the widened edge.
			const x0 = Math.floor((r.left - box.left) * scale);
			const y0 = Math.floor((r.top - box.top) * scale);
			const x1 = Math.ceil((r.right - box.left) * scale);
			const y1 = Math.ceil((r.bottom - box.top) * scale);
			const o = slot * 4;
			table[o] = x0;
			table[o + 1] = y0;
			table[o + 2] = Math.min(x1, texture.width) - x0;
			table[o + 3] = Math.min(y1, texture.height) - y0;
			this.#rasterized[slot] = 1;
			if (slot > maxSlot) maxSlot = slot;
		}
		if (maxSlot >= 0) {
			device.queue.writeBuffer(this.#entriesBuffer!, 0, table, 0, (maxSlot + 1) * 4);
		}
		this.paintVersion++;
		this.#coordinator.invalidateChart(this.#chartId);
	}

	/** Whether `slot`'s string has been painted into the texture (and not released since). */
	isRasterized(slot: number): boolean {
		return slot >= 0 && this.#rasterized[slot] === 1;
	}

	/** The texture at least `width` × `height` texels, and the entry table; rebinds on growth. */
	#ensureResources(device: GPUDevice, width: number, height: number): void {
		this.#entriesBuffer ??= device.createBuffer({
			label: `text-atlas-entries-${this.#chartId}`,
			size: ATLAS_TABLE_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		const t = this.#texture;
		if (t && t.width >= width && t.height >= height) return;

		const max = device.limits.maxTextureDimension2D;
		const w = Math.min(max, Math.max(width, t?.width ?? 0));
		const h = Math.min(
			max,
			Math.ceil(Math.max(height, t?.height ?? 0) / HEIGHT_STEP) * HEIGHT_STEP
		);
		t?.destroy();
		this.#texture = device.createTexture({
			label: `text-atlas-${this.#chartId}`,
			size: [w, h],
			format: ATLAS_FORMAT,
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.RENDER_ATTACHMENT
		});
		this.#coordinator!.setChartTextAtlas(this.#chartId, {
			view: this.#texture.createView(),
			entries: this.#entriesBuffer
		});
	}

	destroy(): void {
		this.#coordinator?.setChartTextAtlas(this.#chartId, null);
		this.#texture?.destroy();
		this.#entriesBuffer?.destroy();
		this.#texture = null;
		this.#entriesBuffer = null;
		this.#device = null;
		this.#coordinator = null;
	}
}
