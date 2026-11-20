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
 *
 * ONE REGISTRY, A SURFACE PER CANVAS. The strings and their slots belong to
 * the chart (one atlas per `ChartContainer`); each canvas that draws the chart
 * is a surface: it renders the same spans in its own container and paints them
 * into its own texture and table, bound to its own chart id. A facet grid's
 * text layers live once, in the pass-through canvas, and draw in every cell
 * with the same slots: each cell's surface has the strings at its own
 * rectangles. Without facets there is one surface.
 */

import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import { parseColorToRGBA } from '$lib/scales/color-utils';
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

/** Context key: the chart's atlas, created by `ChartContainer`, painted by each of its canvases. */
export const CHART_TEXT_ATLAS = 'chart-text-atlas';

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

/**
 * A CSS colour followed into the GPU: `rgba` is the colour as the page
 * computes it now, updated when it changes (a theme switch, a changed custom
 * property). See `TextAtlas.watchColor`.
 */
export class AtlasColor {
	rgba = $state<[number, number, number, number]>([0, 0, 0, 1]);
	refs = 0;
	constructor(
		readonly css: string,
		initial: [number, number, number, number]
	) {
		this.rgba = initial;
	}
}

interface Entry {
	key: string;
	item: AtlasItem;
	refs: number;
}

/**
 * One canvas the atlas is painted into: its texture and entry table, bound to
 * its chart. Per canvas, not per chart id: a facet grid's cells are keyed by
 * category while their ids are positional, so a new cell can take an id whose
 * old canvas has not been destroyed yet.
 */
export interface AtlasSurface {
	chartId: string;
	texture: GPUTexture | null;
	entries: GPUBuffer | null;
	/** The entry table, mirrored on the CPU: rewritten at each paint. */
	table: Float32Array<ArrayBuffer>;
	/** Whether each slot's string is in this surface's texture. */
	rasterized: Uint8Array;
	/** Painted at least once: a surface that never paints holds no label back. */
	painted: boolean;
	/**
	 * Whether its canvas is laid out (has a size). One that is not (display:
	 * none, zero size) gets no paint events, so it holds no label back either.
	 * A canvas scrolled out of view is laid out, and does get them (measured on
	 * Chrome 157 with /test/flat-chart?paintlog=1).
	 *
	 * Not the coordinator's viewport visibility (GPUCoordinator's
	 * IntersectionObserver, isChartVisible), which asks whether a chart is
	 * worth spending work on, keyed by chart id: an offscreen canvas is not
	 * visible there but still paints, so it is the wrong test for this.
	 */
	laidOut: boolean;
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

	/**
	 * The CSS colours text and axes are drawn in, each a one-pixel swatch in the
	 * atlas container (WebGPUCanvas renders them). The container is drawable, so
	 * a swatch whose colour changes is a change the canvas repaints for, and
	 * `paint` reads it: colours follow the page's CSS as SVG did, with no
	 * listeners for themes, media queries or style changes.
	 */
	swatches = $state<AtlasColor[]>([]);

	readonly #entries: (Entry | null)[] = [];
	readonly #byKey = new Map<string, number>();
	readonly #free: number[] = [];
	#itemsScheduled = false;
	#warnedFull = false;

	readonly #zeroRow = new Float32Array(ATLAS_ENTRY_BYTES / 4);

	#device: GPUDevice | null = null;
	#coordinator: GPUCoordinator | null = null;
	/** The canvases painting this atlas. */
	readonly #surfaces = new Set<AtlasSurface>();
	/** Which surface's texture each chart id is bound to at the coordinator. */
	readonly #boundBy = new Map<string, AtlasSurface>();

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
		for (const surface of this.#surfaces) surface.rasterized[slot] = 0;
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
		for (const surface of this.#surfaces) {
			surface.rasterized[slot] = 0;
			surface.table.fill(0, slot * 4, slot * 4 + 4);
			if (surface.entries && this.#device) {
				this.#device.queue.writeBuffer(surface.entries, slot * ATLAS_ENTRY_BYTES, this.#zeroRow);
			}
		}
		this.#scheduleItems();
	}

	/**
	 * Follow CSS colour `css` (`var(--fjader-text-secondary, #6b7280)`,
	 * `currentColor`), starting from `initial`. Counted: `unwatchColor` once per
	 * call.
	 */
	watchColor(css: string, initial: [number, number, number, number]): AtlasColor {
		let color = this.swatches.find((c) => c.css === css);
		if (!color) {
			color = new AtlasColor(css, initial);
			this.swatches = [...this.swatches, color];
		}
		color.refs++;
		return color;
	}

	unwatchColor(color: AtlasColor): void {
		if (--color.refs > 0) return;
		this.swatches = this.swatches.filter((c) => c !== color);
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

	/**
	 * Start painting into a canvas: the device, and the canvas's chart id at the
	 * coordinator. The surface is the canvas's handle for `paint` and `detach`.
	 */
	attach(device: GPUDevice, coordinator: GPUCoordinator, chartId: string): AtlasSurface {
		this.#device = device;
		this.#coordinator = coordinator;
		const surface: AtlasSurface = {
			chartId,
			texture: null,
			entries: null,
			table: new Float32Array(ATLAS_TABLE_BYTES / 4),
			rasterized: new Uint8Array(ATLAS_MAX_ENTRIES),
			painted: false,
			laidOut: true
		};
		this.#surfaces.add(surface);
		return surface;
	}

	/**
	 * Draw `container` into `surface`'s texture and rebuild its entry table.
	 * Runs in that canvas's `paint` handler, which fires after layout whenever
	 * the container would be drawn differently.
	 */
	paint(canvas: HTMLCanvasElement, container: HTMLElement, surface: AtlasSurface): void {
		this.#readSwatches(container);
		const device = this.#device;
		if (!device || !this.#coordinator || !this.#surfaces.has(surface)) return;
		const size = (canvas as DrawableCanvas).getElementImageDefaultSize(container);
		const width = Math.ceil(size.width);
		const height = Math.ceil(size.height);
		if (width === 0 || height === 0) return;

		this.#ensureResources(device, surface, width, height);
		const texture = surface.texture!;
		(device.queue as DrawableQueue).drawElementImageToTexture(
			{ source: container },
			{ texture, size: [Math.min(texture.width, width), Math.min(texture.height, height)] }
		);

		// Layout to texels: the canvas rasterizes at its own scale (its backing
		// store over its CSS size, the device pixel ratio).
		const box = container.getBoundingClientRect();
		const scale = box.width > 0 ? size.width / box.width : 1;
		const table = surface.table;
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
			surface.rasterized[slot] = 1;
			if (slot > maxSlot) maxSlot = slot;
		}
		if (maxSlot >= 0) {
			device.queue.writeBuffer(surface.entries!, 0, table, 0, (maxSlot + 1) * 4);
		}
		surface.painted = true;
		this.paintVersion++;
		this.#coordinator.invalidateChart(surface.chartId);
	}

	/** Each swatch's colour as the page computes it now, where it changed. */
	#readSwatches(container: HTMLElement): void {
		if (this.swatches.length === 0) return;
		for (const child of container.children) {
			const css = (child as HTMLElement).dataset.swatch;
			if (css === undefined) continue;
			const color = this.swatches.find((c) => c.css === css);
			if (!color) continue;
			const [r, g, b, a] = parseColorToRGBA(getComputedStyle(child).backgroundColor);
			const now = color.rgba;
			if (now[0] !== r || now[1] !== g || now[2] !== b || now[3] !== a) color.rgba = [r, g, b, a];
		}
	}

	/**
	 * Whether `slot`'s string has been painted (and not released since) in every
	 * canvas that has painted and is laid out: a facet grid's label switches to
	 * a new string only once each cell can draw it, and a hidden cell (no paint
	 * events) does not hold the others back.
	 */
	isRasterized(slot: number): boolean {
		if (slot < 0) return false;
		let any = false;
		for (const surface of this.#surfaces) {
			if (!surface.painted || !surface.laidOut) continue;
			if (surface.rasterized[slot] !== 1) return false;
			any = true;
		}
		return any;
	}

	/** A surface's texture at least `width` × `height` texels, and its entry table; rebinds on growth. */
	#ensureResources(device: GPUDevice, surface: AtlasSurface, width: number, height: number): void {
		surface.entries ??= device.createBuffer({
			label: `text-atlas-entries-${surface.chartId}`,
			size: ATLAS_TABLE_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		const t = surface.texture;
		if (t && t.width >= width && t.height >= height) return;

		const max = device.limits.maxTextureDimension2D;
		const w = Math.min(max, Math.max(width, t?.width ?? 0));
		const h = Math.min(
			max,
			Math.ceil(Math.max(height, t?.height ?? 0) / HEIGHT_STEP) * HEIGHT_STEP
		);
		t?.destroy();
		surface.texture = device.createTexture({
			label: `text-atlas-${surface.chartId}`,
			size: [w, h],
			format: ATLAS_FORMAT,
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.RENDER_ATTACHMENT
		});
		this.#coordinator!.setChartTextAtlas(surface.chartId, {
			view: surface.texture.createView(),
			entries: surface.entries
		});
		this.#boundBy.set(surface.chartId, surface);
	}

	/**
	 * Stop painting into a canvas, and free its texture and table. Its chart's
	 * binding is cleared only if this surface set it: a newer canvas with the
	 * same chart id keeps its own.
	 */
	detach(surface: AtlasSurface): void {
		if (!this.#surfaces.delete(surface)) return;
		if (this.#boundBy.get(surface.chartId) === surface) {
			this.#coordinator?.setChartTextAtlas(surface.chartId, null);
			this.#boundBy.delete(surface.chartId);
		}
		surface.texture?.destroy();
		surface.entries?.destroy();
		// A string pending on this canvas alone may be drawable now: the text
		// layers waiting on paintVersion look again.
		this.paintVersion++;
		if (this.#surfaces.size === 0) {
			this.#device = null;
			this.#coordinator = null;
		}
	}

	/**
	 * Whether `surface`'s canvas is laid out. A change can make a pending
	 * string drawable (or not yet), so the text layers waiting on paintVersion
	 * look again.
	 */
	setLaidOut(surface: AtlasSurface, laidOut: boolean): void {
		if (surface.laidOut === laidOut) return;
		surface.laidOut = laidOut;
		this.paintVersion++;
	}

	/** Detach every canvas. */
	destroy(): void {
		for (const surface of [...this.#surfaces]) this.detach(surface);
	}
}
