import type { EventHandler, PointerEventHandler } from 'svelte/elements';

declare module 'svelte/elements' {
	// pointerrawupdate (Chromium) is missing from Svelte's DOM typings. ChartCell
	// listens to it for hover at the device's full pointer rate.
	interface DOMAttributes<T extends EventTarget> {
		onpointerrawupdate?: PointerEventHandler<T> | undefined | null;
	}

	// HTML-in-Canvas (Chrome 157+), not yet in Svelte's typings. A canvas with
	// content="drawable" (layoutsubtree before 157) lays out its children
	// without painting them, fires `paint` when they would be drawn
	// differently, and draws the ones marked `drawable` on request. The chart
	// canvas hosts its text atlas this way (WebGPUCanvas).
	interface HTMLCanvasAttributes {
		content?: 'drawable' | 'fallback' | undefined | null;
		layoutsubtree?: boolean | '' | undefined | null;
		onpaint?: EventHandler<Event, HTMLCanvasElement> | undefined | null;
	}
	interface HTMLAttributes<T extends EventTarget> {
		drawable?: boolean | '' | undefined | null;
	}
}

export {};
